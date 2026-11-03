import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Database} from '../apps/server/db.js';
import {KnowledgeService} from '../apps/server/knowledge.js';
import {ModelGateway} from '../apps/server/models.js';
import {SecretStore} from '../apps/server/secrets.js';
import {SearchProvider} from '../apps/server/network.js';

const hit={title:'地方特色饮食资料',url:'https://example.org/food?utm_source=test',content:'北京烤鸭搭配薄饼、葱丝、黄瓜和甜面酱。这里记录地方饮食的常见搭配与食用方式，方便以后检索参考。',fetchedAt:'2026-10-30T00:00:00Z'};
it('archives cache hits from both search and fetch, without breaking results on a storage failure',async()=>{
  const seen:any[]=[];
  const provider=new SearchProvider('http://unused',{cache:{get:async(kind:string)=>kind==='search'?[hit]:hit} as any,
    onResults:async(hits:any,context:any)=>{seen.push({hits,context});throw new Error('storage offline');}});
  expect(await provider.search('北京美食')).toEqual([hit]);
  expect(await provider.fetch('https://example.org/food')).toEqual(hit);
  expect(seen.map(item=>item.context.kind)).toEqual(['search','fetch']);
  expect(seen[0].context.query).toBe('北京美食');
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('web results become searchable knowledge',()=>{
  let db:Database,admin:Database,service:KnowledgeService,schema:string;
  beforeAll(async()=>{
    const url=new URL(process.env.TEST_DATABASE_URL!);if(url.pathname!=='/liino_test')throw new Error('Dedicated test database required');
    schema='web_knowledge_'+randomUUID().replaceAll('-','');admin=new Database(url.href);await admin.query('CREATE SCHEMA '+schema);
    url.searchParams.set('options','-c search_path='+schema+',public');db=new Database(url.href);await db.migrate();
    service=new KnowledgeService(db,new ModelGateway(),new SecretStore('unused',false));
  });
  afterAll(async()=>{await db.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();});
  it('deduplicates concurrent results, immediately searches them and queues indexing once',async()=>{
    await Promise.all([service.rememberWebResults([hit],{kind:'search',query:'北京美食'}),service.rememberWebResults([hit],{kind:'search',query:'北京烤鸭'})]);
    const docs=(await db.query("SELECT * FROM documents WHERE category='联网检索·自动收录'")).rows;
    expect(docs).toHaveLength(1);expect(docs[0].source).toBe('https://example.org/food');
    expect(docs[0].content).toContain('搜索摘要');expect(docs[0].content).toContain('2026-10-30');
    expect((await service.search('北京烤鸭')).some(item=>item.source==='https://example.org/food')).toBe(true);
    expect((await db.query("SELECT * FROM outbox WHERE kind='index'")).rows).toHaveLength(1);
  });
  it('updates changed full text in place, prevents snippet downgrade and replaces stale chunks',async()=>{
    const full={...hit,url:'https://example.org/food',content:'宁波汤圆用糯米皮包黑芝麻等甜馅，煮熟后连汤食用。这份更新后的网页正文介绍浙江地方甜点，适合查阅。'};
    await service.rememberWebResults([full],{kind:'fetch'});
    await service.rememberWebResults([hit],{kind:'search',query:'北京烤鸭'});
    const docs=(await db.query('SELECT * FROM documents')).rows;expect(docs).toHaveLength(1);
    expect(docs[0].content).toContain('宁波汤圆');expect(docs[0].content).toContain('网页正文');expect(docs[0].content).not.toContain(hit.content);
    expect((await service.search('宁波汤圆')).some(item=>item.source===full.url)).toBe(true);
  });
  it('upgrades identical snippets to full-text provenance and ignores older snapshots',async()=>{
    const newer={...hit,url:'https://example.org/same',fetchedAt:'2026-10-30T00:01:00Z'};
    await service.rememberWebResults([newer],{kind:'search'});
    await service.rememberWebResults([newer],{kind:'fetch'});
    await service.rememberWebResults([{...newer,content:hit.content+'过期的内容。',fetchedAt:'2026-10-29T00:00:00Z'}],{kind:'fetch'});
    const doc=(await db.query('SELECT * FROM documents WHERE source=$1',[newer.url])).rows[0];
    expect(doc.web_kind).toBe('fetch');expect(doc.tags).toContain('网页正文');
    expect(doc.content).toContain('网页正文');expect(doc.content).not.toContain('过期的内容');
  });
  it('does not publish private query text or replace a current snippet with an older page',async()=>{
    const current={...hit,url:'https://example.org/fresh',fetchedAt:'2026-10-30T00:02:00Z'};
    await service.rememberWebResults([current],{kind:'search',query:'群里私人补充词'});
    await service.rememberWebResults([{...current,content:hit.content+'已过期正文。',fetchedAt:'2026-10-29T00:00:00Z'}],{kind:'fetch'});
    const doc=(await db.query('SELECT * FROM documents WHERE source=$1',[current.url])).rows[0];
    expect(doc.content).not.toContain('群里私人补充词');expect(doc.content).not.toContain('已过期正文');
  });
  it('does not let ignored snippets advance the full-text snapshot time',async()=>{
    const url='https://example.org/same';
    await service.rememberWebResults([{...hit,url,fetchedAt:'2026-10-30T00:03:00Z'}],{kind:'search'});
    await service.rememberWebResults([{...hit,url,content:hit.content+'后来更新的网页正文。',fetchedAt:'2026-10-30T00:02:00Z'}],{kind:'fetch'});
    const doc=(await db.query('SELECT * FROM documents WHERE source=$1',[url])).rows[0];
    expect(doc.content).toContain('后来更新的网页正文');
  });
  it('skips empty, short, non-public and error-page results',async()=>{
    const bad=[{...hit,url:'file:///foo'},{...hit,url:'http://127.0.0.1/private'},
      {...hit,url:'https://example.org/empty',content:'  '},{...hit,url:'https://example.org/short',content:'没有找到结果'},
      {...hit,url:'https://example.org/error',content:'Access denied. Please enable JavaScript and cookies to continue. Access denied.'}];
    await service.rememberWebResults(bad,{kind:'search',query:'测试'});
    expect((await db.query('SELECT * FROM documents')).rows).toHaveLength(3);
  });
});
