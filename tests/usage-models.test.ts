import { createServer } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ModelGateway, textTool, EmbeddingProvider } from '../apps/server/models.js';
import type { ModelConfig } from '../packages/contracts.js';
import type { UsageCall, UsageStore } from '../apps/server/usage.js';
let server: ReturnType<typeof createServer>, baseUrl: string;
const calls: UsageCall[] = [];
const payloads: any[] = [];
let requests = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (part) => (body += part));
    req.on('end', () => {
      const payload = JSON.parse(body);
      payloads.push(payload);
      requests++;
      if (payload.model === 'http-error-usage') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'sensitive fixture secret-key-123' },
            usage: {
              prompt_tokens: 9,
              completion_tokens: 1,
              total_tokens: 10,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          }),
        );
        return;
      }
      if (req.url?.endsWith('/embeddings')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [{ embedding: [1, 2] }],
            usage: { prompt_tokens: 5, total_tokens: 5 },
          }),
        );
        return;
      }
      if (payload.model === 'retry' && requests === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
        res.end(JSON.stringify({ error: { message: 'fixture busy' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const tool = payload.model === 'tool' && requests === 1;
      const event = (data: any) => res.write('data: ' + JSON.stringify(data) + '\n\n');
      if (payload.model === 'error-usage' || payload.model === 'abort-usage') {
        event({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [
            { index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        });
        if (payload.model === 'error-usage')
          event({ error: { message: 'fixture sensitive provider error secret-key-123' } });
        res.end('data: [DONE]\n\n');
        return;
      }
      event({
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [
          {
            index: 0,
            delta: tool
              ? {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'tool1',
                      type: 'function',
                      function: { name: 'read', arguments: '{"query":"test"}' },
                    },
                  ],
                }
              : { role: 'assistant', content: '完成' },
            finish_reason: null,
          },
        ],
      });
      event({
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
        ...(payload.model === 'missing'
          ? {}
          : {
              usage: {
                prompt_tokens: 100,
                completion_tokens: 30,
                total_tokens: 130,
                prompt_tokens_details: { cached_tokens: 40 },
                completion_tokens_details: { reasoning_tokens: 10 },
              },
            }),
      });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + (server.address() as any).port + '/v1';
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
function fixture(model: string) {
  calls.length = 0;
  requests = 0;
  const config: ModelConfig = {
    id: 'fixture',
    name: 'fixture',
    model,
    baseUrl,
    protocol: 'openai-compatible',
    contextWindow: 32768,
    supportsTools: model === 'tool',
    pricing: { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 1, currency: 'CNY' },
  };
  const usage = {
    record: async (call: UsageCall) => {
      calls.push(call);
      return 'fixture';
    },
  } as UsageStore;
  return { config, gateway: new ModelGateway(usage), usage };
}
it('records and returns every current tool round, excluding reconstructed history', async () => {
  const { gateway, config } = fixture('tool');
  const result = await gateway.run({
    model: config,
    systemPrompt: 'fixture',
    input: 'hello',
    history: [{ role: 'assistant', content: 'old' }],
    context: { purpose: 'preview', chatId: 'chat-a' },
    tools: [textTool('read', 'read', 'read', 'query', async () => 'ok')],
  });
  expect(result.text).toBe('完成');
  expect(calls).toHaveLength(2);
  expect(result.usage).toMatchObject({ inputTotal: 200, output: 60, reasoning: 20, total: 260 });
  expect(calls[0]).toMatchObject({ purpose: 'preview', chatId: 'chat-a', round: 1 });
  expect(calls[1].round).toBe(2);
  expect(calls.reduce((sum, call) => sum + (call.cost ?? 0), 0)).toBeCloseTo(0.00092);
});
it('retains unknown reporting instead of SDK default zero', async () => {
  const { gateway, config } = fixture('missing');
  const result = await gateway.run({
    model: config,
    systemPrompt: 'fixture',
    input: 'hi',
    history: [],
  });
  expect(result.usage).toMatchObject({ inputTotal: null, output: null, cacheRead: null });
  expect(calls[0].cost).toBeNull();
});
it('records SDK retry attempts separately', async () => {
  const { gateway, config } = fixture('retry');
  await gateway.run({
    model: config,
    systemPrompt: 'fixture',
    input: 'hi',
    history: [],
    context: { purpose: 'test', attempt: 3 },
  });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({ attempt: 3, status: 'error', httpStatus: 429 });
  expect(calls[1]).toMatchObject({ attempt: 4, status: 'success' });
});
it('records embedding usage without recording its text', async () => {
  const { usage } = fixture('embedding');
  const provider = new EmbeddingProvider(baseUrl, 'embed', undefined, {
    usage,
    scope: 'chat-a',
    version: 2,
  });
  expect(await provider.embed('private input')).toEqual([1, 2]);
  expect(calls[0]).toMatchObject({
    purpose: 'embedding',
    usage: { inputTotal: 5, total: 5, output: 0 },
  });
  expect(JSON.stringify(calls)).not.toContain('private input');
});
it('retains usage returned before a provider stream error without leaking provider error text', async () => {
  const { gateway, config } = fixture('error-usage');
  await expect(
    gateway.run({
      model: config,
      apiKey: 'secret-key-123',
      systemPrompt: 'fixture',
      input: 'hi',
      history: [],
    }),
  ).rejects.toThrow('模型服务调用失败');
  expect(calls[0]).toMatchObject({
    status: 'error',
    usage: { inputTotal: 12, output: 3, total: 15 },
  });
  expect(JSON.stringify(calls)).not.toContain('secret-key-123');
});
it('retains usage included in an HTTP error response without retaining its message', async () => {
  const { gateway, config } = fixture('http-error-usage');
  await expect(
    gateway.run({
      model: config,
      apiKey: 'secret-key-123',
      systemPrompt: 'fixture',
      input: 'hi',
      history: [],
    }),
  ).rejects.toThrow('模型服务调用失败');
  expect(calls[0]).toMatchObject({
    status: 'error',
    httpStatus: 400,
    usage: { inputTotal: 9, output: 1, total: 10 },
  });
  expect(JSON.stringify(calls)).not.toContain('sensitive fixture');
});
it('retains usage returned before an abort', async () => {
  const { gateway, config } = fixture('abort-usage'),
    controller = new AbortController();
  await expect(
    gateway.run({
      model: config,
      systemPrompt: 'fixture',
      input: 'hi',
      history: [],
      signal: controller.signal,
      onDelta: () => controller.abort(),
    }),
  ).rejects.toThrow();
  expect(calls[0]).toMatchObject({
    status: 'aborted',
    usage: { inputTotal: 12, output: 3, total: 15 },
  });
});
it('passes declared vision images to Pi without recording their data', async () => {
  const { gateway, config } = fixture('vision');
  config.supportsVision = true;
  await gateway.run({
    model: config,
    systemPrompt: 'fixture',
    input: 'tag image',
    history: [],
    images: [{ type: 'image', mimeType: 'image/png', data: 'fixture-image-base64' }],
    context: { purpose: 'media-tag' },
  });
  expect(
    payloads
      .at(-1)
      .messages.some(
        (m: any) =>
          Array.isArray(m.content) && m.content.some((part: any) => part.type === 'image_url'),
      ),
  ).toBe(true);
  expect(JSON.stringify(calls)).not.toContain('fixture-image-base64');
});
it('rejects images before transport when vision is undeclared', async () => {
  const { gateway, config } = fixture('text');
  await expect(
    gateway.run({
      model: config,
      systemPrompt: 'fixture',
      input: 'tag',
      history: [],
      images: [{ type: 'image', mimeType: 'image/png', data: 'fixture' }],
    }),
  ).rejects.toThrow('视觉');
  expect(requests).toBe(0);
});
