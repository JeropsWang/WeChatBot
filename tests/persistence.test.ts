import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Database } from '../apps/server/db.js';
import { randomUUID } from 'node:crypto';

describe.skipIf(!process.env.TEST_DATABASE_URL)('PostgreSQL durable application state', () => {
  let db: Database;
  beforeAll(async () => { if (!new URL(process.env.TEST_DATABASE_URL!).pathname.endsWith('_test')) throw new Error('Integration tests require a dedicated *_test database'); db = new Database(process.env.TEST_DATABASE_URL!); await db.migrate(); });
  afterAll(async () => { await db.close(); });
  it('atomically admits a message and outbox job, but preserves identical independent messages', async () => {
    const chat = await db.createChat({ name:'测试-'+randomUUID(), bindingKey:randomUUID() });
    const event = { eventId:randomUUID(), chatId:chat.id, accountId:'test',content:'相同的文字',observedAt:new Date().toISOString(),isSelf:false,mentioned:true,type:'text' as const };
    const first = await db.ingest(event); const again = await db.ingest(event);
    expect(first).toBeTruthy(); expect(again).toBeNull();
    expect(await db.ingest({ ...event,eventId:randomUUID() })).toBeTruthy();
    const messages = await db.messages(chat.id); expect(messages).toHaveLength(2);
    const count = await db.query('SELECT count(*)::int AS n FROM outbox WHERE chat_id=$1 AND kind=$2',[chat.id,'chat']); expect(count.rows[0].n).toBe(2);
  });
  it('retrieves shared memories across chats and excludes deleted memory immediately', async () => {
    const content='测试记忆'+randomUUID();
    const memory = await db.saveMemory({ content,category:'事实',status:'active',confidence:1,pinned:true });
    expect((await db.keywordSearch(content)).some(hit=>hit.id===memory.id)).toBe(true);
    await db.deleteMemory(memory.id);
    expect((await db.keywordSearch(content)).some(hit=>hit.id===memory.id)).toBe(false);
    const history = await db.query('SELECT * FROM memory_versions WHERE memory_id=$1',[memory.id]); expect(history.rowCount).toBeGreaterThan(0);
  });
  it('isolates short-term transcripts by chat', async () => {
    const chat = await db.createChat({ name:'另一群'+randomUUID(), bindingKey:randomUUID() });
    expect(await db.messages(chat.id)).toHaveLength(0);
  });
});
