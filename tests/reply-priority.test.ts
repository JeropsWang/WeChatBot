import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Database } from '../apps/server/db.js';
import { MembersService } from '../apps/server/members.js';
import { Pipeline } from '../apps/server/pipeline.js';
import type { IncomingMessage } from '../packages/contracts.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('plan reply admission and revocation', () => {
  let admin: Database,
    db: Database,
    schema: string,
    engine: Pipeline,
    chat: any,
    members: MembersService,
    planId: string,
    prefix: string;
  const authors = new Map<string, string>(),
    runs: string[] = [];
  let hold = false,
    release: () => void = () => {};
  const gateway = {
    run: async (input: any) => {
      const text = JSON.parse(input.input).content;
      runs.push(text);
      if (hold && runs.length === 1) await new Promise<void>((r) => (release = r));
      return { text, usage: {} };
    },
  };
  const event = (name: string, text: string): IncomingMessage => {
    const id = randomUUID();
    authors.set(id, name);
    return {
      eventId: id,
      chatId: chat.id,
      accountId: 'fixture',
      content: text,
      observedAt: new Date().toISOString(),
      mentioned: true,
      isSelf: false,
      type: 'text',
    };
  };
  async function route(name: string, text: string) {
    const id = await engine.ingest(event(name, text));
    const task = randomUUID();
    await engine.process('route', { messageId: id }, task);
    return (
      await db.query("SELECT * FROM outbox WHERE kind='reply' AND payload->>'messageId'=$1", [id])
    ).rows[0];
  }
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    if (url.pathname !== '/liino_test') throw Error('Requires liino_test');
    schema = 'priority_' + randomUUID().replaceAll('-', '');
    admin = new Database(url.href);
    await admin.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema + ',public');
    db = new Database(url.href);
    await db.migrate();
    chat = await db.createChat({ name: 'priority', bindingKey: 'fixture' });
    await db.query('UPDATE chats SET enabled=true,verified=true,proactive=false WHERE id=$1', [
      chat.id,
    ]);
    const modelId = randomUUID();
    await db.query('INSERT INTO models(id,config) VALUES($1,$2)', [
      modelId,
      {
        id: modelId,
        name: 'fixture',
        protocol: 'openai-compatible',
        model: 'fixture',
        contextWindow: 32768,
      },
    ]);
    await db.updateSettings((s) => ({ ...s, paused: false, chatModelId: modelId }));
    members = new MembersService(db);
    const evidenceEvent = event('plan', '审核证据');
    const resolved = await members.resolveUiName(
      chat.id,
      'plan',
      'a'.repeat(64),
      evidenceEvent.eventId,
    );
    if (resolved.status !== 'matched') throw Error('fixture');
    planId = resolved.memberId;
    const source = await db.ingest(evidenceEvent);
    await db.query("UPDATE messages SET raw=$2,state='observed' WHERE id=$1", [
      source,
      {
        uiIdentityStatus: 'matched',
        uiMemberId: planId,
        uiAppearanceHash: 'a'.repeat(64),
        identitySource: 'wechat-ui-profile',
      },
    ]);
    await members.reviewMember(chat.id, planId, { action: 'approve', evidenceMessageId: source! });
    await members.setPlanMembers(chat.id, [planId]);
    await members.saveModeSettings({ jeropsPrompt: 'special', planPrompt: 'plan prompt' });
    await members.modeCommand(chat.id, planId, 'plan');
    prefix = 'priority-' + randomUUID();
    engine = new Pipeline(
      db,
      {
        status: () => ({ connected: true, capabilities: {} }),
        listChats: async () => [],
        send: async () => ({ status: 'sent' }),
        identityReply: async (q) => ({
          status: 'candidate',
          eventId: q.eventId,
          name: authors.get(q.eventId) ?? 'ordinary',
          appearanceHash: 'a'.repeat(64),
          identitySource: 'wechat-ui-profile',
        }),
      },
      gateway as any,
      { get: async () => undefined } as any,
      { search: async () => [], index: async () => {} } as any,
      () => {},
      'redis://127.0.0.1:63799',
      prefix,
      { members },
    );
  });
  afterAll(async () => {
    release();
    const names = engine ? [...(engine as any).queues.keys()] : [];
    await engine?.close();
    for (const name of names) {
      const q = new Queue(name, { connection: { host: '127.0.0.1', port: 63799 } });
      await q.obliterate({ force: true });
      await q.close();
    }
    await db?.close();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.close();
  });
  it('routes without generating, and cancels a prepared privileged reply after revocation', async () => {
    const job = await route('plan', '撤权前的问题');
    expect(runs).toEqual([]);
    expect(job.payload.priority).toBe(1);
    expect(job.payload.context.mode).toBe('plan');
    await members.reviewMember(chat.id, planId, { action: 'revoke' });
    expect(await engine.process('reply', job.payload, job.id)).toMatchObject({
      status: 'cancelled',
    });
    expect(runs).toEqual([]);
    await db.query("UPDATE tasks SET state='cancelled'");
    const source = (
      await db.query(
        "SELECT id FROM messages WHERE raw->>'uiMemberId'=$1 ORDER BY seq DESC LIMIT 1",
        [planId],
      )
    ).rows[0].id;
    await members.reviewMember(chat.id, planId, { action: 'approve', evidenceMessageId: source });
    await members.setPlanMembers(chat.id, [planId]);
    await members.modeCommand(chat.id, planId, 'plan');
  });
  it('finishes active normal work, then runs queued plan before queued ordinary work', async () => {
    hold = true;
    await engine.start();
    const first = await engine.ingest(event('ordinary', '普通一'));
    const wait = async (check: () => Promise<boolean>) => {
      const until = Date.now() + 10000;
      while (!(await check())) {
        if (Date.now() > until) throw Error('wait timed out');
        await engine.flushOutbox();
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    await wait(async () => runs.length === 1);
    await engine.ingest(event('ordinary', '普通二'));
    await engine.ingest(event('plan', '计划三'));
    await wait(
      async () =>
        Number(
          (
            await db.query(
              "SELECT count(*) n FROM outbox WHERE kind='reply' AND payload->>'input' IN ('普通二','计划三') AND published_at IS NOT NULL",
            )
          ).rows[0].n,
        ) === 2,
    );
    expect(runs).toEqual(['普通一']);
    release();
    await wait(async () => runs.length === 3);
    expect(runs).toEqual(['普通一', '计划三', '普通二']);
    const plan = (
      await db.query(
        "SELECT reply_priority,reply_mode,actor_member_id FROM sends WHERE content='计划三'",
      )
    ).rows[0];
    expect(plan).toMatchObject({ reply_priority: 1, reply_mode: 'plan', actor_member_id: planId });
  }, 20000);
});
