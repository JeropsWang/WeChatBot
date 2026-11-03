import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {Database} from '../apps/server/db.js';
import {UsageStore,normalizeUsage} from '../apps/server/usage.js';
describe.skipIf(!process.env.TEST_DATABASE_URL)('isolated usage persistence',()=>{
  let admin:Database,db:Database,schema:string,store:UsageStore;
  beforeAll(async()=>{const url=new URL(process.env.TEST_DATABASE_URL!);if(url.pathname!=='/liino_test')throw new Error('Requires liino_test');schema='usage_'+randomUUID().replaceAll('-','');admin=new Database(url.href);await admin.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema+',public');db=new Database(url.href);await db.migrate();store=new UsageStore(db);});
  afterAll(async()=>{await db?.close();if(admin){await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.close();}});
  it('filters, paginates and computes weighted cache rates without mixing currencies',async()=>{
    const common={runId:randomUUID(),modelId:'fixture',modelName:'fixture',protocol:'openai-compatible',purpose:'test',chatId:'chat-a',round:1,attempt:1,status:'success',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),pricing:null};
    await store.record({...common,usage:normalizeUsage({prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:50}}),cost:1,currency:'CNY'});
    await store.record({...common,usage:normalizeUsage({prompt_tokens:900,completion_tokens:20,total_tokens:920,prompt_tokens_details:{cached_tokens:0}}),cost:2,currency:'USD'});
    await store.record({...common,chatId:'chat-b',usage:normalizeUsage(undefined),cost:null,currency:null,status:'error'});
    const summary=await store.summary({chatId:'chat-a'});expect(summary.calls).toBe(2);expect(summary.usage.inputTotal).toBe(1000);expect(summary.cacheReadTokenRate).toBe(.05);expect(summary.cacheHitRequestRate).toBe(.5);expect(summary.costs).toHaveLength(2);
    const calls=await store.calls({chatId:'chat-a',page:1,pageSize:20});expect(calls.total).toBe(2);const detail=await store.getCall(calls.items[0].id);expect(detail?.modelId).toBe('fixture');expect(detail?.rounds).toHaveLength(3);expect(detail?.runUsage.inputTotal).toBe(1000);expect(detail?.runCost).toBeNull();expect(await store.getCall('invalid')).toBeNull();
    const all=await store.summary();expect(all.calls).toBe(3);expect(all.knownCounts.inputTotal).toBe(2);expect(all.errors).toBe(1);await expect(store.summary({from:'invalid'})).rejects.toThrow('统计时间无效');
  });
});
