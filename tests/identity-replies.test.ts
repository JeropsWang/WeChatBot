import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database } from '../apps/server/db.js';
import { Pipeline } from '../apps/server/pipeline.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('identified reply integration', () => {
  let db: Database, admin: Database, engine: Pipeline, schema: string, chat: any;
  const runs: any[] = [];
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    if (url.pathname !== '/liino_test') throw Error('Requires isolated liino_test');
    schema = 'reply_' + randomUUID().replaceAll('-', '');
    admin = new Database(url.href);
    await admin.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema + ',public');
    db = new Database(url.href);
    await db.migrate();
    chat = await db.createChat({ name: '非测试群', bindingKey: 'fixture' });
    await db.query('UPDATE chats SET enabled=true,verified=true WHERE id=$1', [chat.id]);
    const id = randomUUID();
    await db.query('INSERT INTO models(id,config) VALUES($1,$2)', [
      id,
      {
        id,
        name: 'fixture',
        model: 'fixture',
        protocol: 'openai-compatible',
        contextWindow: 32768,
        baseUrl: 'http://fixture.invalid',
      },
    ]);
    await db.updateSettings((s) => ({ ...s, paused: false, chatModelId: id }));
    engine = new Pipeline(
      db,
      {
        status: () => ({ connected: true, capabilities: {} }),
        listChats: async () => [],
        send: async () => ({ status: 'sent' }),
        identityReply: async (q) => ({
          status: 'candidate',
          eventId: q.eventId,
          name: '甲',
          identitySource: 'wechat-ui-profile',
          appearanceHash: 'a'.repeat(64),
        }),
      },
      {
        run: async (input: any) => {
          runs.push(input);
          return { text: '回复', usage: {} };
        },
      } as any,
      { get: async () => undefined } as any,
      { search: async () => [] } as any,
      () => {},
      'redis://127.0.0.1:63799',
    );
  });
  afterAll(async () => {
    await engine?.close();
    await db?.close();
    if (admin) {
      await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
      await admin.close();
    }
  });
  const event = (content: string) => ({
    eventId: randomUUID(),
    chatId: chat.id,
    accountId: 'test',
    content,
    botNickname: 'bot',
    observedAt: new Date().toISOString(),
    isSelf: false,
    mentioned: true,
    type: 'text' as const,
  });
  it('creates an ordinary member in any approved group and gives the model an actor', async () => {
    const input = event('@bot 你好'),
      messageId = await engine.ingest(input);
    await engine.process('chat', { messageId }, randomUUID());
    expect((await db.query('SELECT identity_status FROM members')).rows).toEqual([
      { identity_status: 'unknown' },
    ]);
    expect(JSON.parse(runs.at(-1).input).speaker).toMatchObject({ name: '甲', number: 1 });
    expect(
      (await db.query('SELECT raw FROM messages WHERE id=$1', [messageId])).rows[0].raw
        .uiIdentityStatus,
    ).toBe('matched');
  });
  it('saves a leading-mentioned /remember only to the resolved member and consumes it', async () => {
    const messageId = await engine.ingest(event('@bot /记住 喜欢茶'));
    const task = randomUUID();
    await engine.process('chat', { messageId }, task);
    const rows = (await db.query('SELECT visibility,member_id,scope_chat_id FROM memories')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ visibility: 'member', scope_chat_id: chat.id });
    expect(rows[0].member_id).toBeTruthy();
    expect(
      (await db.query('SELECT memory_processed_at FROM messages WHERE id=$1', [messageId])).rows[0]
        .memory_processed_at,
    ).toBeTruthy();
  });
  it('deduplicates replay before observing a claimed sender', async () => {
    const input = event('same'),
      id = await engine.ingest(input);
    expect(id).toBeTruthy();
    const spy = (engine as any).members.observe;
    let calls = 0;
    (engine as any).members.observe = async () => {
      calls++;
      throw Error('must not observe replay');
    };
    try {
      expect(await engine.ingest(input)).toBeNull();
      expect(calls).toBe(0);
    } finally {
      (engine as any).members.observe = spy;
    }
  });
  it('does not restore a send body that expired while the bridge was sending', async () => {
    const id = randomUUID();
    await engine.reply(id, chat.id, null, '过期正文', 'explicit');
    const channel = (engine as any).channel,
      original = channel.send;
    channel.send = async () => {
      await db.query("UPDATE sends SET payload_expired=true,content='' WHERE id=$1", [id]);
      return { status: 'sent' };
    };
    try {
      await engine.process('send', { sendId: id }, randomUUID());
      expect(
        (await db.query('SELECT id FROM messages WHERE event_id=$1', ['sent-' + id])).rows,
      ).toHaveLength(0);
    } finally {
      channel.send = original;
    }
  });
});
