import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database } from '../apps/server/db.js';
import { KnowledgeService } from '../apps/server/knowledge.js';
import {
  cleanupSlot,
  selectMemoryMessages,
  scheduleMemoryBatches,
  resetMemories,
  MemoryRetentionService,
} from '../apps/server/memory-lifecycle.js';

describe('memory lifecycle bounds', () => {
  it('uses the latest Shanghai 04:00 slot across midnight', () => {
    expect(cleanupSlot(new Date('2026-10-28T19:59:00Z')).toISOString()).toBe(
      '2026-10-27T20:00:00.000Z',
    );
    expect(cleanupSlot(new Date('2026-10-28T20:00:00Z')).toISOString()).toBe(
      '2026-10-28T20:00:00.000Z',
    );
  });
  it('caps whole evidence messages by both count and characters', () => {
    expect(
      selectMemoryMessages(Array.from({ length: 60 }, (_, i) => ({ id: String(i), content: 'a' }))),
    ).toHaveLength(50);
    expect(
      selectMemoryMessages([
        { id: 'a', content: 'a'.repeat(10000) },
        { id: 'b', content: 'b'.repeat(7000) },
      ]).map((x) => x.id),
    ).toEqual(['a']);
    expect(selectMemoryMessages([{ id: 'a', content: 'a'.repeat(16000) }])).toHaveLength(1);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('isolated memory lifecycle integration', () => {
  let db: Database, admin: Database, schema: string;
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    if (url.pathname !== '/liino_test') throw new Error('Requires liino_test');
    schema = 'lifecycle_' + randomUUID().replaceAll('-', '');
    admin = new Database(url.href);
    await admin.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema + ',public');
    db = new Database(url.href);
    await db.migrate();
  });
  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
      await admin.close();
    }
  });
  async function source(content: string, known = true) {
    const chat = await db.createChat({
        name: 'lifecycle-' + randomUUID(),
        bindingKey: randomUUID(),
      }),
      memberId = randomUUID();
    await db.query(
      "INSERT INTO members(id,chat_id,number,sender_key,nickname) VALUES($1,$2,1,$3,'资料卡用户')",
      [memberId, chat.id, 'ui-profile:' + randomUUID()],
    );
    const eventId = randomUUID(),
      messageId = await db.ingest({
        eventId,
        chatId: chat.id,
        accountId: 'fixture',
        content,
        observedAt: new Date().toISOString(),
        isSelf: false,
        mentioned: true,
        type: 'text',
      });
    if (known)
      await db.query(
        "UPDATE messages SET raw=raw||$2::jsonb,state='observed',created_at=now()-interval '6 minutes' WHERE id=$1",
        [
          messageId,
          JSON.stringify({
            uiIdentityStatus: 'matched',
            uiMemberId: memberId,
            identitySource: 'wechat-ui-profile',
          }),
        ],
      );
    return { chat, memberId, messageId, eventId };
  }
  async function model() {
    const id = randomUUID();
    await db.query('INSERT INTO models(id,config) VALUES($1,$2)', [
      id,
      {
        id,
        name: 'fixture',
        model: 'fixture',
        protocol: 'openai-compatible',
        baseUrl: 'http://fixture.invalid',
        contextWindow: 32768,
        supportsTools: false,
      },
    ]);
    await db.updateSettings((s) => ({ ...s, chatModelId: id }));
  }
  it('does not claim a pending reply or command before its handler has consumed the message', async () => {
    const a = await source('/记住 我喜欢咖啡');
    await db.query("UPDATE messages SET state='pending' WHERE id=$1", [a.messageId]);
    await scheduleMemoryBatches(db, a.chat.id);
    expect(
      (await db.query("SELECT id FROM outbox WHERE kind='memory' AND chat_id=$1", [a.chat.id]))
        .rowCount,
    ).toBe(0);
    expect(
      (await db.query('SELECT memory_batch_id FROM messages WHERE id=$1', [a.messageId])).rows[0]
        .memory_batch_id,
    ).toBeNull();
    await db.query("UPDATE messages SET state='processed',memory_processed_at=now() WHERE id=$1", [
      a.messageId,
    ]);
    await scheduleMemoryBatches(db, a.chat.id);
    expect(
      (await db.query("SELECT id FROM outbox WHERE kind='memory' AND chat_id=$1", [a.chat.id]))
        .rowCount,
    ).toBe(0);
  });
  it('claims only recognized evidence, writes member scope, and consumes the batch once', async () => {
    await model();
    const a = await source('我喜欢咖啡'),
      b = await source('未知发言', false);
    await scheduleMemoryBatches(db, b.chat.id);
    expect(
      (await db.query("SELECT 1 FROM outbox WHERE kind='memory' AND chat_id=$1", [b.chat.id]))
        .rowCount,
    ).toBe(0);
    await scheduleMemoryBatches(db, a.chat.id);
    await scheduleMemoryBatches(db, a.chat.id);
    const jobs = (
      await db.query("SELECT * FROM outbox WHERE kind='memory' AND chat_id=$1", [a.chat.id])
    ).rows;
    expect(jobs).toHaveLength(1);
    let calls = 0;
    const service = new KnowledgeService(
      db,
      {
        run: async () => {
          calls++;
          return {
            text: JSON.stringify({
              memories: [
                {
                  content: '喜欢咖啡',
                  category: '偏好',
                  confidence: 1,
                  evidence: [a.messageId],
                  memberId: a.memberId,
                },
              ],
            }),
            usage: {},
          };
        },
      } as any,
      { get: async () => undefined } as any,
    );
    await service.extractBatch(jobs[0].payload, jobs[0].id);
    await service.extractBatch(jobs[0].payload, jobs[0].id);
    expect(calls).toBe(1);
    expect(
      (
        await db.query(
          'SELECT visibility,scope_chat_id,member_id FROM memories WHERE source_batch=$1',
          [jobs[0].id],
        )
      ).rows,
    ).toEqual([{ visibility: 'member', scope_chat_id: a.chat.id, member_id: a.memberId }]);
  });
  it('discards an in-flight model result after reset and rejects old observed events', async () => {
    await model();
    const a = await source('重置前偏好');
    await scheduleMemoryBatches(db, a.chat.id);
    const job = (
      await db.query("SELECT * FROM outbox WHERE kind='memory' AND chat_id=$1", [a.chat.id])
    ).rows[0];
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((r) => (entered = r)),
      ready = new Promise<void>((r) => (release = r));
    const service = new KnowledgeService(
      db,
      {
        run: async () => {
          entered();
          await ready;
          return {
            text: JSON.stringify({
              memories: [
                { content: '不应复活', category: '偏好', confidence: 1, evidence: [a.messageId] },
              ],
            }),
            usage: {},
          };
        },
      } as any,
      { get: async () => undefined } as any,
    );
    const extracting = service.extractBatch(job.payload, job.id);
    await waiting;
    const identity = (
      await db.query('SELECT id,number,nickname,sender_key FROM members ORDER BY id')
    ).rows;
    await db.query('UPDATE members SET profile=$2 WHERE id=$1', [
      a.memberId,
      { summary: '旧画像' },
    ]);
    await resetMemories(db);
    release();
    await extracting;
    expect((await db.query('SELECT id FROM memories')).rowCount).toBe(0);
    expect(
      (await db.query('SELECT id,number,nickname,sender_key FROM members ORDER BY id')).rows,
    ).toEqual(identity);
    expect(
      (await db.query('SELECT profile FROM members WHERE id=$1', [a.memberId])).rows[0].profile,
    ).toEqual({});
    const late = await db.ingest({
      eventId: randomUUID(),
      chatId: a.chat.id,
      accountId: 'fixture',
      content: '迟到旧消息',
      observedAt: '2026-01-01T00:00:00Z',
      isSelf: false,
      mentioned: true,
      type: 'text',
    });
    if (late)
      await db.query(
        "UPDATE messages SET raw=$2,state='observed',created_at=now()-interval '6 minutes' WHERE id=$1",
        [
          late,
          {
            uiIdentityStatus: 'matched',
            uiMemberId: a.memberId,
            identitySource: 'wechat-ui-profile',
          },
        ],
      );
    await scheduleMemoryBatches(db, a.chat.id);
    expect(
      (
        await db.query(
          "SELECT id FROM tasks WHERE chat_id=$1 AND kind='memory' AND state<>'cancelled'",
          [a.chat.id],
        )
      ).rowCount,
    ).toBe(0);
  });
  it('removes expired bodies, preserves receipts and identity, and runs once per due slot', async () => {
    const a = await source('过期原文'),
      recent = await source('仍保留的新消息');
    const sendId = randomUUID();
    await db.query("UPDATE messages SET created_at=now()-interval '31 days' WHERE id=$1", [
      a.messageId,
    ]);
    await db.query(
      "INSERT INTO sends(id,chat_id,content,kind,status,epoch,created_at) VALUES($1,$2,'过期回复','explicit','unknown',0,now()-interval '31 days')",
      [sendId, a.chat.id],
    );
    await db.query('UPDATE memory_control SET last_cleanup_at=NULL WHERE id=1');
    const cleaner = new MemoryRetentionService(db);
    expect(await cleaner.run()).not.toBeNull();
    expect(await cleaner.run()).toBeNull();
    expect((await db.query('SELECT id FROM messages WHERE id=$1', [a.messageId])).rowCount).toBe(0);
    expect(
      (await db.query('SELECT content FROM messages WHERE id=$1', [recent.messageId])).rows[0]
        .content,
    ).toBe('仍保留的新消息');
    expect(
      (await db.query('SELECT event_id FROM message_receipts WHERE event_id=$1', [a.eventId]))
        .rowCount,
    ).toBe(1);
    expect(
      (await db.query('SELECT content,status,payload_expired FROM sends WHERE id=$1', [sendId]))
        .rows[0],
    ).toEqual({ content: '', status: 'unknown', payload_expired: true });
    expect((await db.query('SELECT id FROM members WHERE id=$1', [a.memberId])).rowCount).toBe(1);
  });
});
