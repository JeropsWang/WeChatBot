import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../apps/server/db.js';
import { KnowledgeService } from '../apps/server/knowledge.js';
import { ModelGateway, type RunInput } from '../apps/server/models.js';
import { SecretStore } from '../apps/server/secrets.js';
import { defaultSettings, type ModelConfig } from '../packages/contracts.js';
import { AppCache } from '../apps/server/cache.js';
import { UsageStore } from '../apps/server/usage.js';
import {resolvedMemberSql,resetMemories} from '../apps/server/memory-lifecycle.js';

class FixtureGateway extends ModelGateway {
  respond: (input: RunInput) => Promise<unknown> = async () => ({ memories: [] });
  override async run(input: RunInput) { return { text: JSON.stringify(await this.respond(input)), usage: {} }; }
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('shared knowledge and evidence-backed memories', () => {
  let db: Database, bootstrap: Database, service: KnowledgeService, gateway: FixtureGateway;
  let server: ReturnType<typeof createServer>, baseUrl: string, schema: string;
  let embedding: (text: string) => Promise<number[]>;
  const modelId = randomUUID();
  const model: ModelConfig = { id: modelId, name: '记忆测试模型', protocol: 'openai-compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32768, supportsTools: false };
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    if (url.pathname !== '/liino_test') throw new Error('Knowledge tests require the dedicated liino_test database');
    schema = 'knowledge_' + randomUUID().replaceAll('-', '');
    bootstrap = new Database(url.href);
    await bootstrap.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema + ',public');
    db = new Database(url.href);
    await db.migrate();
    await db.query('INSERT INTO models(id,config) VALUES($1,$2)', [modelId, model]);
    server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const vector = await embedding(JSON.parse(body).input);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ embedding: vector }] }));
        } catch {
          res.writeHead(503); res.end('fixture unavailable');
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = 'http://127.0.0.1:' + (server.address() as any).port + '/v1';
  });
  beforeEach(async () => {
    await db.saveSettings({ ...structuredClone(defaultSettings), chatModelId: modelId });
    gateway = new FixtureGateway();
    service = new KnowledgeService(db, gateway, new SecretStore('unused-knowledge-fixture', false));
    embedding = async () => [1, 0, 0];
  });
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (db) await db.close();
    if (bootstrap) {
      if (!/^knowledge_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected cleanup schema');
      await bootstrap.query('DROP SCHEMA ' + schema + ' CASCADE');
      await bootstrap.close();
    }
  });

  async function enableEmbeddings(version = 1) {
    const settings = await db.settings();
    settings.embedding = { enabled: true, baseUrl, model: 'fixture-vector', version };
    await db.saveSettings(settings);
  }
  async function inbound(chatId: string, content: string, senderId: string | null = 'member-17', isSelf = false) {
    const id = await db.ingest({ eventId: randomUUID(), chatId, accountId: 'fixture', content, senderId, senderName: '重复昵称', observedAt: new Date().toISOString(), isSelf, mentioned: false, type: 'text' });
    if (senderId) {
      let member = (await db.query('SELECT id FROM members WHERE chat_id=$1 AND nickname=$2',[chatId,senderId])).rows[0];
      if (!member) member = (await db.query(`INSERT INTO members(id,chat_id,number,sender_key,nickname,identity_status)
        SELECT $1,$2,coalesce(max(number),0)+1,$3,$3,'verified' FROM members WHERE chat_id=$2 RETURNING id`,[randomUUID(),chatId,senderId])).rows[0];
      await db.query("UPDATE messages SET raw=raw||$2::jsonb,state='observed' WHERE id=$1",[id,JSON.stringify({identityStatus:'verified',memberId:member.id})]);
    }
    return (await db.query('SELECT * FROM messages WHERE id=$1', [id])).rows[0];
  }
  async function chat() { return db.createChat({ name: '来源群' + randomUUID(), bindingKey: randomUUID() }); }
  async function extractKnown(chatId:string,uptoSeq:number,batchId:string){
    const rows=(await db.query(`SELECT m.* FROM messages m JOIN members member ON member.id::text=(${resolvedMemberSql()}) AND member.chat_id=m.chat_id WHERE m.chat_id=$1 AND m.seq<=$2 AND m.direction='in' AND m.memory_processed_at IS NULL ORDER BY m.seq`,[chatId,uptoSeq])).rows;
    if(!rows.length)return service.extract(chatId,uptoSeq,batchId);
    const memberId=rows[0].raw.memberId??rows[0].raw.uiMemberId;
    const selected=rows.filter(m=>(m.raw.memberId??m.raw.uiMemberId)===memberId);
    await db.query('UPDATE messages SET memory_batch_id=$1 WHERE id=ANY($2::uuid[])',[batchId,selected.map(m=>m.id)]);
    const epoch=(await db.query('SELECT epoch FROM memory_control WHERE id=1')).rows[0].epoch;
    return service.extractBatch({chatId,memberId,messageIds:selected.map(m=>m.id),memoryEpoch:epoch},batchId);
  }


  it('imports Chinese chunks atomically with overlap, metadata and usable keyword fallback', async () => {
    const marker = '知识星标' + randomUUID();
    const content = '甲'.repeat(920) + marker + '乙'.repeat(1400);
    const doc = await service.importDocument({ title: '群共享手册', content, source: 'file://手册.txt', category: '流程', tags: ['共享'] });
    const first = (await db.query('SELECT * FROM chunks WHERE document_id=$1 ORDER BY ordinal', [doc.id])).rows;
    expect(first.length).toBeGreaterThan(2);
    expect(first.every(row => [...row.content].length <= 1000)).toBe(true);
    expect(first[0].content.slice(-150)).toBe(first[1].content.slice(0, 150));
    await service.index({ documentId: doc.id });
    await service.index({ documentId: doc.id });
    const second = (await db.query('SELECT * FROM chunks WHERE document_id=$1 ORDER BY ordinal', [doc.id])).rows;
    expect(second.map(row => row.id)).toEqual(first.map(row => row.id));
    const stored = (await db.query('SELECT * FROM documents WHERE id=$1', [doc.id])).rows[0];
    expect(stored).toMatchObject({ category: '流程', tags: ['共享'], status: 'keyword-only' });
    expect((await service.search(marker)).some(hit => hit.kind === 'knowledge' && hit.title === '群共享手册' && hit.source === 'file://手册.txt')).toBe(true);
    await expect(service.embeddingTest()).rejects.toThrow(/配置|启用/);
  });

  it('retrieves active memory shared across groups and immediately excludes deleted or candidate entries', async () => {
    const source = await chat();
    await chat();
    const term = '共同约定' + randomUUID();
    const memory = await db.saveMemory({ content: term, category: '事实', status: 'active', sourceChatId: source.id });
    const candidate = await db.saveMemory({ content: term, category: '事实', status: 'candidate' });
    const hits = await service.search(term);
    expect(hits.find(hit => hit.id === memory.id)).toMatchObject({ kind: 'memory', source: source.name });
    expect(hits.some(hit => hit.id === candidate.id)).toBe(false);
    await db.deleteMemory(memory.id);
    expect((await service.search(term)).some(hit => hit.id === memory.id)).toBe(false);
  });

  it('combines semantic matches with keywords while skipping incompatible vector dimensions', async () => {
    await enableEmbeddings();
    const doc = await service.importDocument({ title: '语义检索资料', content: '雨天安排室内攀岩', source: 'fixture://semantic' });
    await service.index({ documentId: doc.id });
    const wrongDimension = await db.saveMemory({ content: '不兼容维度' + randomUUID(), category: '事实', status: 'active' });
    await db.query('UPDATE memories SET embedding=$2::vector,embedding_version=1 WHERE id=$1', [wrongDimension.id, '[1,0]']);
    const hits = await service.search('周末运动去哪里');
    expect(hits.some(hit => hit.kind === 'knowledge' && hit.source === 'fixture://semantic')).toBe(true);
    expect(hits.some(hit => hit.id === wrongDimension.id)).toBe(false);
    expect(await service.embeddingTest()).toEqual({ dimensions: 3 });
  });

  it('keeps keyword search available when an explicitly configured embedding service fails', async () => {
    await enableEmbeddings();
    embedding = async () => { throw new Error('offline'); };
    const marker = '离线仍可搜索' + randomUUID();
    const doc = await service.importDocument({ title: '离线资料', content: marker, source: 'fixture://offline' });
    await service.index({ documentId: doc.id });
    expect((await service.search(marker)).some(hit => hit.source === 'fixture://offline')).toBe(true);
    expect((await db.query('SELECT status FROM documents WHERE id=$1', [doc.id])).rows[0].status).toBe('keyword-only');
    expect((await db.query("SELECT count(*)::int n FROM runtime_logs WHERE level='warn'")).rows[0].n).toBeGreaterThan(0);
  });

  it('rejects obsolete embedding workers after version changes and queues every shared item for reindexing', async () => {
    await enableEmbeddings();
    const doc = await service.importDocument({ title: '版本切换', content: '重建期间仍可全文搜索', source: 'fixture://versions' });
    const memory = await db.saveMemory({ content: '版本记忆' + randomUUID(), category: '事实' });
    let started!: () => void, release!: () => void;
    const startedPromise = new Promise<void>(resolve => started = resolve);
    const releasePromise = new Promise<void>(resolve => release = resolve);
    embedding = async () => { started(); await releasePromise; return [1, 0, 0]; };
    const indexing = service.index({ documentId: doc.id });
    await startedPromise;
    await enableEmbeddings(2);
    release(); await indexing;
    expect((await db.query('SELECT embedding FROM chunks WHERE document_id=$1', [doc.id])).rows.every(row => row.embedding === null)).toBe(true);
    embedding = async () => [1, 0, 0, 0];
    await service.index({ documentId: doc.id });
    expect((await db.query('SELECT embedding_version,vector_dims(embedding) dimensions FROM chunks WHERE document_id=$1', [doc.id])).rows[0]).toEqual({ embedding_version: 2, dimensions: 4 });
    await service.reindexAll();
    const jobs = (await db.query("SELECT payload FROM outbox WHERE unique_key LIKE 'reindex-%'")).rows.map(row => row.payload);
    expect(jobs.some(payload => payload.documentId === doc.id)).toBe(true);
    expect(jobs.some(payload => payload.memoryId === memory.id)).toBe(true);
  });

  it('does not resurrect vectors when memory is deleted during an embedding request', async () => {
    await enableEmbeddings();
    const memory = await db.saveMemory({ content: '删除竞争' + randomUUID(), category: '事实' });
    let started!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => started = resolve);
    const ready = new Promise<void>(resolve => release = resolve);
    embedding = async () => { started(); await ready; return [1, 0, 0]; };
    const indexing = service.index({ memoryId: memory.id });
    await waiting; await db.deleteMemory(memory.id); release(); await indexing;
    expect((await db.query('SELECT status,embedding FROM memories WHERE id=$1', [memory.id])).rows[0]).toEqual({ status: 'deleted', embedding: null });
    expect((await service.search(memory.content)).some(hit => hit.id === memory.id)).toBe(false);
  });

  it('does not publish vectors for memory content edited during an embedding request', async () => {
    await enableEmbeddings();
    const memory = await db.saveMemory({ content: '编辑前' + randomUUID(), category: '事实' });
    let started!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => started = resolve), ready = new Promise<void>(resolve => release = resolve);
    embedding = async () => { started(); await ready; return [1, 0, 0]; };
    const indexing = service.index({ memoryId: memory.id });
    await Promise.race([waiting, indexing.then(() => { throw new Error('Index did not request an embedding'); })]);
    await db.saveMemory({ id: memory.id, content: '编辑后的新事实', category: '事实' });
    release(); await indexing;
    expect((await db.query('SELECT content,version,embedding FROM memories WHERE id=$1', [memory.id])).rows[0]).toEqual({ content: '编辑后的新事实', version: 2, embedding: null });
  });

  it('rechecks memory deletion after a semantic search waits for the network', async () => {
    await enableEmbeddings();
    const memory = await db.saveMemory({ content: '检索删除竞争' + randomUUID(), category: '事实' });
    let started!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => started = resolve), ready = new Promise<void>(resolve => release = resolve);
    embedding = async () => { started(); await ready; return [1, 0, 0]; };
    const searching = service.search(memory.content);
    await Promise.race([waiting, searching.then(() => { throw new Error('Search did not request an embedding'); })]);
    await db.deleteMemory(memory.id);
    release();
    expect((await searching).some(hit => hit.id === memory.id)).toBe(false);
  });

  it('stores and searches an 8192-dimensional provider vector as numeric pgvector data', async () => {
    await enableEmbeddings(8192);
    embedding = async () => [1, ...Array<number>(8191).fill(0)];
    const memory = await db.saveMemory({ content: '大维度检索' + randomUUID(), category: '事实' });
    await service.index({ memoryId: memory.id });
    expect((await db.query('SELECT vector_dims(embedding) dimensions FROM memories WHERE id=$1', [memory.id])).rows[0].dimensions).toBe(8192);
    expect((await service.search(memory.content)).some(hit => hit.id === memory.id)).toBe(true);
  });

  it('extracts only new inbound evidence, classifies certainty and replays a batch without duplication', async () => {
    const source = await chat();
    const first = await inbound(source.id, '我们周六上午九点集合');
    const outbound = await inbound(source.id, '机器人自己生成的内容', null, true);
    const batch = randomUUID();
    gateway.respond = async input => {
      const snapshot = JSON.parse(input.input);
      expect(snapshot.messages.map((message: any) => message.id)).toEqual([first.id]);
      return { memories: [
        { content: '周六九点集合' + batch, category: '事件', confidence: 0.96, evidence: [first.id] },
        { content: '可能周六集合' + batch, category: '事件', confidence: 0.6, evidence: [first.id] },
      ] };
    };
    await extractKnown(source.id, Number(outbound.seq), batch);
    await extractKnown(source.id, Number(outbound.seq), batch);
    const memories = (await db.query('SELECT * FROM memories WHERE source_batch=$1 ORDER BY confidence DESC', [batch])).rows;
    expect(memories).toHaveLength(2);
    expect(memories[0]).toMatchObject({ status: 'active', source_chat_id: source.id, source_message_ids: [first.id] });
    expect(memories[1].status).toBe('candidate');
    expect((await db.query('SELECT memory_processed_at FROM messages WHERE id=$1',[first.id])).rows[0].memory_processed_at).not.toBeNull();
  });

  it('never invokes the model or stores even event memories for unknown senders',async()=>{
    const source=await chat(),message=await inbound(source.id,'我喜欢乌龙茶',null),batch=randomUUID();
    gateway.respond=async()=>{throw new Error('unknown sender must not reach the model');};
    await extractKnown(source.id,Number(message.seq),batch);
    expect((await db.query('SELECT id FROM memories WHERE source_batch=$1',[batch])).rowCount).toBe(0);
  });

  it('does not infer ownership of group facts from the author of their evidence', async () => {
    const source = await chat(), message = await inbound(source.id, '我们在周六去郊游'), batch = randomUUID();
    gateway.respond = async () => ({ memories: [{ content: '群成员周六郊游', category: '事件', confidence: 1, evidence: [message.id] }] });
    await extractKnown(source.id, Number(message.seq), batch);
    const memory = (await db.query('SELECT subject_key,source_message_ids FROM memories WHERE source_batch=$1', [batch])).rows[0];
    expect(memory).toEqual({ subject_key: null, source_message_ids: [message.id] });
  });

  it('rejects hallucinated evidence atomically and permits retry with actual evidence', async () => {
    const source = await chat();
    const message = await inbound(source.id, '证据必须是真实的消息');
    const batch = randomUUID();
    gateway.respond = async () => ({ memories: [{ content: '不能凭空引用消息', category: '事实', confidence: 1, evidence: [randomUUID()] }] });
    await expect(extractKnown(source.id, Number(message.seq), batch)).rejects.toThrow(/证据/);
    expect((await db.query('SELECT * FROM memories WHERE source_batch=$1', [batch])).rowCount).toBe(0);
    expect(Number((await db.query('SELECT memory_cursor FROM chats WHERE id=$1', [source.id])).rows[0].memory_cursor)).toBe(0);
    gateway.respond = async () => ({ memories: [{ content: '真实证据引用', category: '事实', confidence: 1, evidence: [message.id] }] });
    await extractKnown(source.id, Number(message.seq), batch);
    expect((await db.query('SELECT * FROM memories WHERE source_batch=$1', [batch])).rowCount).toBe(1);
  });

  it('strictly validates proposal shape, category, confidence and maximum proposal count', async () => {
    const source = await chat();
    const message = await inbound(source.id, '严格验证结构');
    const valid = { content: '一条记忆', category: '事实', confidence: 1, evidence: [message.id] };
    for (const response of [
      { memories: [{ ...valid, category: '个人档案' }] },
      { memories: [{ ...valid, confidence: 1.1 }] },
      { memories: [{ ...valid, owner: '昵称' }] },
      { memories: Array.from({ length: 13 }, () => valid) },
    ]) {
      gateway.respond = async () => response;
      await expect(extractKnown(source.id, Number(message.seq), randomUUID())).rejects.toThrow(/格式/);
    }
  });

  it('marks validated conflicts without modifying a pinned manual memory and deduplicates proposals', async () => {
    const source = await chat(), message = await inbound(source.id, '新的说法与旧记录存在冲突'), batch = randomUUID();
    const existing = await db.saveMemory({ content: '固定手动记忆' + randomUUID(), category: '事实', pinned: true,visibility:'member',scopeChatId:source.id,memberId:message.raw.memberId });
    const proposal = { content: '存在冲突的新说法', category: '事实', confidence: 1, evidence: [message.id], conflictWith: existing.id };
    gateway.respond = async () => ({ memories: [proposal, proposal] });
    await extractKnown(source.id, Number(message.seq), batch);
    expect((await db.query('SELECT * FROM memories WHERE source_batch=$1', [batch])).rows).toMatchObject([{ status: 'conflicted' }]);
    expect((await db.query('SELECT content,pinned,version FROM memories WHERE id=$1', [existing.id])).rows[0]).toEqual({ content: existing.content, pinned: true, version: 1 });
  });

  it('retries a stale extraction snapshot instead of skipping newly unprocessed inbound messages', async () => {
    const source = await chat(), first = await inbound(source.id, '第一条'), second = await inbound(source.id, '第二条');
    let started!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => started = resolve), ready = new Promise<void>(resolve => release = resolve);
    gateway.respond = async () => { started(); await ready; return { memories: [{ content: '过期批次不应保存', category: '事件', confidence: 1, evidence: [first.id, second.id] }] }; };
    const staleBatch = randomUUID();
    const stale = extractKnown(source.id, Number(second.seq), staleBatch);
    const rejection = expect(stale).resolves.toBeUndefined();
    await waiting;
    gateway.respond = async () => ({ memories: [{ content: '已处理第一条', category: '事件', confidence: 1, evidence: [first.id] }] });
    await extractKnown(source.id, Number(first.seq), randomUUID());
    release(); await rejection;
    expect((await db.query('SELECT * FROM memories WHERE source_batch=$1', [staleBatch])).rowCount).toBe(0);
    gateway.respond = async input => {
      expect(JSON.parse(input.input).messages.map((message: any) => message.id)).toEqual([second.id]);
      return { memories: [{ content: '重试处理第二条', category: '事件', confidence: 1, evidence: [second.id] }] };
    };
    await extractKnown(source.id, Number(second.seq), staleBatch);
    expect((await db.query('SELECT source_message_ids FROM memories WHERE source_batch=$1', [staleBatch])).rows[0].source_message_ids).toEqual([second.id]);
  });

  it('requires an explicitly configured memory or chat model instead of silently extracting elsewhere', async () => {
    const settings = await db.settings(); settings.chatModelId = ''; await db.saveSettings(settings);
    const source = await chat(), message = await inbound(source.id, '稍后配置模型再重试');
    await expect(extractKnown(source.id, Number(message.seq), randomUUID())).rejects.toThrow(/配置.*模型|模型.*配置/);
    expect(Number((await db.query('SELECT memory_cursor FROM chats WHERE id=$1', [source.id])).rows[0].memory_cursor)).toBe(0);
  });

  it('isolates keyword and vector retrieval by both group and member, with global-only default', async () => {
    const a=await chat(), b=await chat();
    const message=await inbound(a.id,'成员A'), other=await inbound(b.id,'成员B');
    const memberId=message.raw.memberId, otherMemberId=other.raw.memberId;
    const marker='范围检索'+randomUUID();
    const global=await db.saveMemory({content:marker+'共享',category:'事实'});
    const group=await db.saveMemory({content:marker+'群A',category:'事实',visibility:'chat',scopeChatId:a.id});
    const personal=await db.saveMemory({content:marker+'成员A私密',category:'偏好',visibility:'member',scopeChatId:a.id,memberId});
    const foreign=await db.saveMemory({content:marker+'成员B私密',category:'偏好',visibility:'member',scopeChatId:b.id,memberId:otherMemberId});
    expect((await service.search(marker)).map(x=>x.id)).toEqual([global.id]);
    const groupIds=(await service.search(marker,{chatId:a.id})).map(x=>x.id);
    expect(groupIds).toContain(group.id); expect(groupIds).not.toContain(personal.id);
    const own=(await service.search(marker,{chatId:a.id,memberId})).map(x=>x.id);
    expect(own).toEqual(expect.arrayContaining([global.id,group.id,personal.id])); expect(own).not.toContain(foreign.id);
    const mismatched=(await service.search(marker,{chatId:b.id,memberId})).map(x=>x.id);
    expect(mismatched).not.toContain(personal.id); expect(mismatched).not.toContain(foreign.id);
    await expect(db.saveMemory({content:'错误群归属',category:'偏好',visibility:'member',scopeChatId:b.id,memberId})).rejects.toThrow(/不属于/);
    await enableEmbeddings(); embedding=async()=>[0,1,0];
    for(const memory of [global,group,personal,foreign])await service.index({memoryId:memory.id});
    const semantic=(await service.search('无关键词'+randomUUID(),{chatId:a.id,memberId})).map(x=>x.id);
    expect(semantic).toContain(personal.id); expect(semantic).not.toContain(foreign.id);
    const semanticDefault=(await service.search('另一个无关键词'+randomUUID())).map(x=>x.id);
    expect(semanticDefault).not.toContain(personal.id); expect(semanticDefault).not.toContain(group.id);
    await db.query("UPDATE members SET identity_status='unknown' WHERE id=$1",[memberId]);
    expect((await service.search(marker,{chatId:a.id,memberId})).map(x=>x.id)).not.toContain(personal.id);
  });

  it('rechecks visibility and version if a memory changes while search waits', async () => {
    await enableEmbeddings(); const source=await chat();
    const memory=await db.saveMemory({content:'范围变化'+randomUUID(),category:'事实'});
    let started!:()=>void, release!:()=>void;
    const waiting=new Promise<void>(resolve=>started=resolve), ready=new Promise<void>(resolve=>release=resolve);
    embedding=async()=>{started();await ready;return[1,0,0];};
    const searching=service.search(memory.content); await waiting;
    await db.saveMemory({id:memory.id,content:memory.content,category:'事实',visibility:'chat',scopeChatId:source.id});
    release(); expect((await searching).map(x=>x.id)).not.toContain(memory.id);
  });

  it('uses bounded shared extraction context and attributes personal proposals only to verified evidence', async () => {
    const source=await chat(), foreignChat=await chat();
    const message=await inbound(source.id,'我喜欢茉莉花茶'), foreignMessage=await inbound(foreignChat.id,'保密偏好');
    const memberId=message.raw.memberId;
    const foreign=await db.saveMemory({content:'跨群私密不可进提示'+randomUUID(),category:'偏好',visibility:'member',scopeChatId:foreignChat.id,memberId:foreignMessage.raw.memberId});
    await db.query(`INSERT INTO memories(id,content,category,confidence,status,search_text,visibility)
      SELECT gen_random_uuid(),'茉莉花茶资料'||n,'事实',1,'active',to_tsvector('simple','茉莉 花茶'),'global' FROM generate_series(1,65) n`);
    gateway.respond=async input=>{
      const snapshot=JSON.parse(input.input);
      expect(snapshot.existingMemories.length).toBeLessThanOrEqual(40);
      expect(snapshot.existingMemories.some((x:any)=>x.id===foreign.id)).toBe(false);
      expect(snapshot.messages[0].memberId).toBe(memberId);
      return {memories:[{content:'喜欢茉莉花茶',category:'偏好',confidence:1,evidence:[message.id],memberId}]};
    };
    const batch=randomUUID();await extractKnown(source.id,Number(message.seq),batch);
    expect((await db.query('SELECT visibility,scope_chat_id,member_id FROM memories WHERE source_batch=$1',[batch])).rows[0]).toEqual({visibility:'member',scope_chat_id:source.id,member_id:memberId});
    const forged=await inbound(source.id,'未知身份自称同一人',null);
    await db.query('UPDATE messages SET raw=$2 WHERE id=$1',[forged.id,{identityStatus:'verified',memberId:foreignMessage.raw.memberId}]);
    gateway.respond=async()=>({memories:[{content:'错误归属',category:'偏好',confidence:1,evidence:[forged.id],memberId:foreignMessage.raw.memberId}]});
    const forgedBatch=randomUUID();await extractKnown(source.id,Number(forged.seq),forgedBatch);
    expect((await db.query('SELECT id FROM memories WHERE source_batch=$1',[forgedBatch])).rowCount).toBe(0);
  });

  it('separates embedding cache entries by chat and records actual embedding calls', async () => {
    await enableEmbeddings();
    const a=await chat(),b=await chat(),values=new Map<string,string>();
    const cache=new AppCache({prefix:'knowledge-fixture-'+randomUUID(),client:{
      get:async key=>values.get(key)??null,set:async(key,value)=>{values.set(key,value);},del:async key=>{values.delete(key);},
    }});
    const usage=new UsageStore(db,cache);
    const scoped=new KnowledgeService(db,gateway,new SecretStore('unused-knowledge-fixture',false),{cache,usage});
    let calls=0;embedding=async()=>{calls++;return[1,0,0];};
    const query='作用域缓存'+randomUUID();
    await scoped.search(query,{chatId:a.id});await scoped.search(query,{chatId:a.id});await scoped.search(query,{chatId:b.id});
    expect(calls).toBe(2);expect(cache.stats().embedding.hits).toBe(1);
    const rows=(await db.query("SELECT chat_id,purpose,status FROM model_calls WHERE chat_id=ANY($1::text[]) ORDER BY started_at",[[a.id,b.id]])).rows;
    expect(rows).toEqual([{chat_id:a.id,purpose:'embedding',status:'success'},{chat_id:b.id,purpose:'embedding',status:'success'}]);
  });
});
