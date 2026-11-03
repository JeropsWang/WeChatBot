import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import http from 'node:http';
import {once} from 'node:events';
vi.mock('node:dns/promises', () => ({lookup: async () => [{address: '8.8.8.8', family: 4}]}));
import {SearchProvider} from '../apps/server/network.js';
import {AppCache} from '../apps/server/cache.js';

describe('DeepSeek official network provider', () => {
  let server: http.Server, baseUrl: string;
  let requests: {path: string; authorization?: string; body: any}[] = [];
  let status = 200, failures = 0, payload: any;
  const secret = 'fixture-secret-must-never-leak';
  const settings = {trustedDomains: ['docs.example'], timeRange: 'all' as const, maxResults: 6, candidateLimit: 100};
  const provider = (extra = {}) => new SearchProvider('http://unused.invalid', {
    provider: 'deepseek', deepseekBaseUrl: baseUrl, apiKey: async () => secret, settings, ...extra,
  });
  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      requests.push({path: req.url!, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null});
      const code = failures-- > 0 ? 429 : status;
      res.writeHead(code, {'Content-Type': 'application/json', ...(code === 429 ? {'Retry-After': '0'} : {})});
      res.end(JSON.stringify(code === 200 ? payload : {error: {message: secret}}));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening'); baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  });
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
  beforeEach(() => {
    requests = []; status = 200; failures = 0;
    payload = {results: [{title: 'widget API', url: 'https://docs.example/api?utm_source=test',
      summary: 'widget API reference', snippet: 'short', content: '', date: '2026-01-01T00:00:00Z', rerank_score: 2.4, authority: 3}]};
  });
  it('uses the official POST schema and maps summaries, dates and sources', async () => {
    const hits = await provider().search('widget API');
    expect(requests[0]).toEqual({path: '/v1/tools/search', authorization: 'Bearer ' + secret,
      body: {query: 'widget API', count: 50, need_content: false}});
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({url: 'https://docs.example/api', content: 'widget API reference',
      publishedAt: '2026-01-01T00:00:00.000Z', sourceType: 'official', readCount: null, score: 2.4});
  });
  it('handles base URLs with or without /v1 and accepts empty results', async () => {
    payload = {results: []};
    expect(await provider({deepseekBaseUrl: baseUrl.replace('/v1', '/')}).search('widget')).toEqual([]);
    expect(requests[0].path).toBe('/v1/tools/search');
  });
  it('reads Markdown through Fetch and retains the requested source URL', async () => {
    payload = {title: 'Article', content: '# Heading\n\n**Markdown body**'};
    const hit = await provider().fetch('https://docs.example/article');
    expect(requests[0].path).toBe('/v1/tools/fetch');
    expect(requests[0].body).toEqual({url: 'https://docs.example/article'});
    expect(hit).toMatchObject({title: 'Article', content: payload.content, url: 'https://docs.example/article', publishedAt: null, readCount: null});
  });
  it('rejects invalid inputs and missing credentials before making requests', async () => {
    await expect(provider().search(' ')).rejects.toThrow();
    await expect(provider().search('字'.repeat(129))).rejects.toThrow(/128/);
    await expect(provider({apiKey: async () => undefined}).search('widget')).rejects.toThrow(/密钥/);
    for (const url of ['http://127.0.0.1/a', 'http://10.0.0.1', 'file:///private', 'https://u:p@example.com'])
      await expect(provider().fetch(url)).rejects.toThrow();
    await expect(provider().fetch('https://docs.example/' + 'a'.repeat(8192))).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
  it('counts Unicode code points rather than UTF-16 units', async () => {
    payload = {results: []}; await provider().search('😀'.repeat(128));
    expect(requests[0].body.query).toBe('😀'.repeat(128));
  });
  it('retries a rate limit once and never echoes provider error bodies', async () => {
    failures = 1; await provider().search('widget'); expect(requests).toHaveLength(2);
    requests = []; status = 402;
    const error = await provider().search('widget').catch(e => e);
    expect(error.message).toMatch(/402.*余额|余额.*402/);
    expect(error.message).not.toContain(secret); expect(requests).toHaveLength(1);
  });
  it('rejects malformed responses and empty Fetch content', async () => {
    payload = {unexpected: true}; await expect(provider().search('widget')).rejects.toThrow(/格式/);
    payload = {title: 'empty', content: ' '}; await expect(provider().fetch('https://docs.example')).rejects.toThrow(/正文/);
  });
  it('caps retries and does not retry credentials or redirect responses', async () => {
    status=503;await expect(provider().search('widget')).rejects.toThrow(/503/);expect(requests).toHaveLength(2);
    for(const code of [401,403,404,302]){requests=[];status=code;await expect(provider().search('widget')).rejects.toThrow();expect(requests).toHaveLength(1);}
  });
  it('keeps query operators intact while ranking the actual search terms', async () => {
    const query='widget site:docs.example after:2025';
    const hits=await provider().search(query);
    expect(requests[0].body.query).toBe(query);expect(hits).toHaveLength(1);
  });
  it('validates the encoded URL length before a Fetch request',async()=>{
    await expect(provider().fetch('https://8.8.8.8/'+'字'.repeat(1000))).rejects.toThrow(/8192/);
    expect(requests).toHaveLength(0);
  });
  it('honors cancellation before any request', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(provider().search('widget', controller.signal)).rejects.toThrow();
    await expect(provider().fetch('https://docs.example', controller.signal)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
  it('isolates cached pages and searches from the SearXNG provider without storing the key', async () => {
    const entries = new Map<string, string>();
    const cache = new AppCache({client: {get: async k => entries.get(k) ?? null,
      set: async (k, v) => {entries.set(k, v);}, del: async k => Number(entries.delete(k))}});
    const deepseek = provider({cache}); await deepseek.search('widget'); await deepseek.search('widget');
    expect(requests).toHaveLength(1);
    const searxng = new SearchProvider(baseUrl, {cache, settings}); await searxng.search('widget');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify([...entries])).not.toContain(secret);
  });
});
