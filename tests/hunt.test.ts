import { it, expect, describe, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../apps/server/db.js';
import { MembersService } from '../apps/server/members.js';
import { ChatImagesService } from '../apps/server/chat-images.js';
import {
  HuntService,
  saveHuntSettings,
  getHuntSettings,
  huntSettingsInput,
} from '../apps/server/hunt.js';
import { Pipeline } from '../apps/server/pipeline.js';
import { resetMemories } from '../apps/server/memory-lifecycle.js';
import { Queue } from 'bullmq';

it('rejects invalid thresholds and requires a nonempty standalone persona', () => {
  const base = {
    enabled: true,
    threshold: 0.75,
    prompt: 'one reply',
    cooldownSeconds: 0,
    version: 1,
  };
  expect(huntSettingsInput.parse(base).threshold).toBe(0.75);
  for (const input of [
    { ...base, threshold: 2 },
    { ...base, prompt: '' },
    { ...base, version: 0 },
  ])
    expect(huntSettingsInput.safeParse(input).success).toBe(false);
});

it('accepts only group-bound member IDs in hunt whitelist settings', () => {
  const base = {
    enabled: true,
    threshold: 0.75,
    prompt: 'one reply',
    cooldownSeconds: 0,
    version: 1,
  };
  const whitelist = [{ chatId: randomUUID(), memberId: randomUUID() }];
  expect(huntSettingsInput.parse({ ...base, whitelist })).toMatchObject({ whitelist });
  expect(
    huntSettingsInput.safeParse({
      ...base,
      whitelist: [{ chatId: whitelist[0].chatId, memberId: 'nickname' }],
    }).success,
  ).toBe(false);
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('OpenCLIP event-to-reply integration', () => {
  let db: Database,
    admin: Database,
    schema: string,
    dir: string,
    chat: any,
    member: string,
    members: MembersService,
    hunt: HuntService,
    images: ChatImagesService,
    engine: Pipeline;
  let score = 0.9,
    matchCalls = 0;
  const runs: any[] = [];
  let hold = false,
    release: () => void = () => {},
    started: () => void = () => {};
  const held = new Set<() => void>();
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGM8YRTAAAZMEIqBgQEAF+gBTt22usoAAAAASUVORK5CYII=';
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    if (url.pathname !== '/liino_test') throw Error('Requires liino_test');
    schema = 'hunt_' + randomUUID().replaceAll('-', '');
    admin = new Database(url.href);
    await admin.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema + ',public');
    db = new Database(url.href);
    await db.migrate();
    dir = await mkdtemp(join(tmpdir(), 'hunt-test-'));
    chat = await db.createChat({ name: 'hunt fixture', bindingKey: randomUUID() });
    await db.query('UPDATE chats SET enabled=true,verified=true,proactive=false WHERE id=$1', [
      chat.id,
    ]);
    await db.query(
      "INSERT INTO identity_bindings(chat_id,account_id,native_chat_id,source,approved,verified_at) VALUES($1,'test',$2,'wechat-database',true,now())",
      [chat.id, chat.id],
    );
    member = randomUUID();
    await db.query(
      "INSERT INTO members(id,chat_id,number,sender_key,nickname,identity_status) VALUES($1,$2,1,$3,'成员甲','verified')",
      [
        member,
        chat.id,
        createHash('sha256')
          .update(JSON.stringify(['test', 'native-' + member]))
          .digest('hex'),
      ],
    );
    const modelId = randomUUID();
    await db.query('INSERT INTO models(id,config) VALUES($1,$2)', [
      modelId,
      {
        id: modelId,
        name: 'test',
        model: 'test',
        protocol: 'openai-compatible',
        baseUrl: 'http://fixture.invalid',
        contextWindow: 32768,
      },
    ]);
    await db.updateSettings((s) => ({ ...s, paused: false, chatModelId: modelId }));
    members = new MembersService(db);
    hunt = new HuntService(db, members);
    const gateway = {
      run: async (input: any) => {
        runs.push(input);
        await input.onPhase?.('generating');
        started();
        if (hold)
          await new Promise<void>((r) => {
            const finish = () => {
              held.delete(finish);
              r();
            };
            held.add(finish);
            release = () => {
              for (const done of [...held]) done();
            };
          });
        return { text: '成员甲，这张合成表情又来了！', usage: {} };
      },
    };
    images = new ChatImagesService(
      db,
      dir,
      gateway as any,
      { get: async () => undefined } as any,
      (c, row) => hunt.enqueue(c, row),
    );
    engine = new Pipeline(
      db,
      {
        status: () => ({ connected: true, capabilities: {} }),
        listChats: async () => [],
        send: async () => ({ status: 'sent' }),
      },
      gateway as any,
      { get: async () => undefined } as any,
      { search: async () => [] } as any,
      () => {},
      'redis://127.0.0.1:63799',
      'hunt-test-' + randomUUID(),
      {
        members,
        chatImages: images,
        hunt,
        imageMatcher: {
          match: async () => {
            matchCalls++;
            return {
              status: 'ok',
              metric: 'cosine_similarity',
              calibrated: false,
              similarity: score,
              matchedReference: 'sample',
              category: '合成表情',
              matches: [],
            };
          },
          close: () => {},
          status: () => ({ running: true, ready: true, referenceCount: 8 }),
        },
      },
    );
    const settings = await getHuntSettings(db);
    await saveHuntSettings(db, { ...settings, cooldownSeconds: 0 });
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
    if (admin) {
      await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
      await admin.close();
    }
    if (dir?.startsWith(join(tmpdir(), 'hunt-test-')))
      await rm(dir, { recursive: true, force: true });
  });
  async function image(owner: string | null = member, override: any = {}, uploadNow = true) {
    const eventId = override.eventId ?? randomUUID(),
      attachmentId = randomUUID();
    const messageId = await engine.ingest({
      eventId,
      chatId: chat.id,
      accountId: 'test',
      content: '[图片]',
      type: 'image',
      observedAt: new Date().toISOString(),
      isSelf: false,
      mentioned: false,
      senderId: owner ? 'native-' + owner : undefined,
      senderName: owner ? '成员甲' : undefined,
      identityStatus: owner ? 'verified' : 'unknown',
      identitySource: 'wechat-database',
      sourceMessageId: eventId,
      nativeChatId: chat.id,
      image: { attachmentId, status: 'pending', quality: 'thumbnail' },
      ...override,
    });
    const upload = {
      attachmentId,
      eventId,
      chatId: chat.id,
      mimeType: 'image/png',
      width: 3,
      height: 2,
      sha256: createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex'),
      quality: 'thumbnail',
      data: png,
    };
    if (uploadNow) await images.upload(upload);
    const job = (
      await db.query('SELECT * FROM outbox WHERE unique_key=$1', ['hunt-' + attachmentId])
    ).rows[0];
    return { messageId, attachmentId, upload, job };
  }
  it('claims a ready attachment once and returns the sender to a text-only model', async () => {
    const a = await image();
    expect(a.job).toBeTruthy();
    await images.upload(a.upload);
    expect(
      (
        await db.query('SELECT count(*)::int n FROM outbox WHERE unique_key=$1', [
          'hunt-' + a.attachmentId,
        ])
      ).rows[0].n,
    ).toBe(1);
    expect(await engine.process('reply', a.job.payload, a.job.id)).toMatchObject({
      status: 'completed',
    });
    expect(runs.at(-1)).toMatchObject({ history: [], tools: [], priority: 5 });
    expect(runs.at(-1).images).toBeUndefined();
    expect(JSON.parse(runs.at(-1).input).sender.memberId).toBe(member);
    expect(
      (
        await db.query('SELECT kind,attachment_id,actor_member_id FROM sends WHERE id=$1', [
          a.job.id,
        ])
      ).rows[0],
    ).toMatchObject({ kind: 'hunt', attachment_id: a.attachmentId, actor_member_id: member });
    const count = runs.length;
    await engine.process('reply', a.job.payload, a.job.id);
    expect(runs.length).toBe(count);
    expect((await db.query('SELECT count(*)::int n FROM member_modes')).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int n FROM memories')).rows[0].n).toBe(0);
  });
  it('blocks whitelisted owners before matching and cancels their pending replies, preserving older client saves', async () => {
    const existing = await image();
    await engine.process('reply', existing.job.payload, existing.job.id);
    const before = await getHuntSettings(db),
      settings = await saveHuntSettings(db, {
        ...before,
        whitelist: [{ chatId: chat.id, memberId: member }],
      });
    expect(
      (await db.query('SELECT status FROM sends WHERE id=$1', [existing.job.id])).rows[0].status,
    ).toBe('cancelled');
    expect((await image()).job).toBeUndefined();
    expect(await hunt.intakeValid(existing.attachmentId, chat.id, settings.version)).toBe(false);
    expect(await hunt.valid(existing.attachmentId, chat.id, member, settings.version)).toBe(false);
    await db.query("UPDATE members SET nickname='已改名成员' WHERE id=$1", [member]);
    expect((await image()).job).toBeUndefined();
    const { whitelist: omitted, ...legacy } = await getHuntSettings(db);
    expect((await saveHuntSettings(db, legacy)).whitelist).toEqual([
      { chatId: chat.id, memberId: member },
    ]);
    await expect(
      saveHuntSettings(db, {
        ...(await getHuntSettings(db)),
        whitelist: [{ chatId: chat.id, memberId: randomUUID() }],
      }),
    ).rejects.toThrow('群成员');
    const otherGroup = await db.createChat({ name: '白名单隔离夹具', bindingKey: randomUUID() });
    await expect(
      saveHuntSettings(db, {
        ...(await getHuntSettings(db)),
        whitelist: [{ chatId: otherGroup.id, memberId: member }],
      }),
    ).rejects.toThrow('群成员');
    await saveHuntSettings(db, { ...(await getHuntSettings(db)), whitelist: [] });
    expect((await image()).job).toBeTruthy();
  });
  it('detects unknown images locally without generating, and skips self or paused images', async () => {
    const unknown = await image(null),
      count = runs.length;
    expect(unknown.job.kind).toBe('hunt-detect');
    expect(await engine.process('hunt-detect', unknown.job.payload, unknown.job.id)).toMatchObject({
      status: 'skipped',
    });
    expect(runs.length).toBe(count);
    expect(
      (await db.query('SELECT hunt_progress FROM chat_images WHERE id=$1', [unknown.attachmentId]))
        .rows[0].hunt_progress.stage,
    ).toBe('blocked_identity');
    expect((await image(member, { isSelf: true })).job).toBeUndefined();
    expect(
      (await image(member, { observedAt: new Date(Date.now() - 3600_000).toISOString() })).job,
    ).toBeUndefined();
    await db.updateSettings((s) => ({ ...s, paused: true }));
    expect((await image()).job).toBeUndefined();
    await db.updateSettings((s) => ({ ...s, paused: false }));
  });
  it('does not call a model at the threshold or with an identity conflict', async () => {
    score = 0.75;
    const a = await image(),
      count = runs.length;
    expect(await engine.process('reply', a.job.payload, a.job.id)).toMatchObject({
      status: 'skipped',
    });
    expect(runs.length).toBe(count);
    score = 0.9;
    const b = await image();
    await db.query("UPDATE members SET identity_status='conflicted' WHERE id=$1", [member]);
    expect(await engine.process('reply', b.job.payload, b.job.id)).toMatchObject({
      status: 'skipped',
    });
    expect(runs.length).toBe(count);
    await db.query("UPDATE members SET identity_status='verified' WHERE id=$1", [member]);
  });
  it('uses the image own UI profile without manual privilege approval', async () => {
    const eventId = randomUUID(),
      a = await image(null, {
        eventId,
        uiCandidate: { eventId, name: 'UI成员乙', appearanceHash: 'b'.repeat(64) },
      });
    expect(a.job).toBeTruthy();
    expect(a.job.payload.context.mode).toBe('normal');
    await engine.process('reply', a.job.payload, a.job.id);
    expect(JSON.parse(runs.at(-1).input).sender.nickname).toBe('UI成员乙');
  });
  it('accepts a unique profile name with a different legacy avatar without calibration', async () => {
    const name = '冲突原因测试';
    const firstId = randomUUID();
    await image(null, {
      eventId: firstId,
      uiCandidate: { eventId: firstId, name, appearanceHash: '1'.repeat(64) },
    });
    const secondId = randomUUID(),
      a = await image(null, {
        eventId: secondId,
        uiCandidate: { eventId: secondId, name, appearanceHash: '2'.repeat(64) },
      });
    const raw = (await db.query('SELECT raw FROM messages WHERE id=$1', [a.messageId])).rows[0].raw;
    expect(raw.uiIdentityStatus).toBe('matched');
    expect(raw.uiIdentityReason).toBeUndefined();
    expect(
      (await db.query('SELECT owner_member_id FROM chat_images WHERE id=$1', [a.attachmentId]))
        .rows[0].owner_member_id,
    ).toBeTruthy();
    expect(await engine.process('reply', a.job.payload, a.job.id)).toMatchObject({
      status: 'completed',
    });
  });
  it('uses the unique live profile name regardless of avatar pixels or descriptors', async () => {
    const name = '头像采样测试',
      descriptor = { version: 1 as const, hash: 'a5'.repeat(16), colors: Array(12).fill(100) };
    const firstId = randomUUID(),
      a = await image(null, {
        eventId: firstId,
        uiCandidate: {
          eventId: firstId,
          name,
          appearanceHash: '3'.repeat(64),
          appearanceDescriptor: descriptor,
        },
      });
    const secondId = randomUUID(),
      b = await image(null, {
        eventId: secondId,
        uiCandidate: {
          eventId: secondId,
          name,
          appearanceHash: '4'.repeat(64),
          appearanceDescriptor: { ...descriptor, hash: 'a5'.repeat(15) + 'a7' },
        },
      });
    const first = await hunt.source(a.attachmentId, chat.id),
      second = await hunt.source(b.attachmentId, chat.id);
    expect(second.owner_member_id).toBe(first.owner_member_id);
    expect(second.raw.uiAppearanceHash).toBe('3'.repeat(64));
    expect(second.raw.uiObservedAppearanceHash).toBe('4'.repeat(64));
    expect(await engine.process('reply', b.job.payload, b.job.id)).toMatchObject({
      status: 'completed',
    });
    const thirdId = randomUUID(),
      c = await image(null, {
        eventId: thirdId,
        uiCandidate: {
          eventId: thirdId,
          name,
          appearanceHash: '5'.repeat(64),
          appearanceDescriptor: { ...descriptor, hash: '00'.repeat(16) },
        },
      });
    expect((await hunt.source(c.attachmentId, chat.id)).owner_member_id).toBe(
      first.owner_member_id,
    );
  });
  it('automatically handles a native animation frame through the image attachment path', async () => {
    const eventId = randomUUID(),
      a = await image(null, {
        eventId,
        content: '[动画表情]',
        uiCandidate: { eventId, name: '动画成员', appearanceHash: 'e'.repeat(64) },
      });
    expect(a.job.payload.hunt).toBe(true);
    expect(await engine.process('reply', a.job.payload, a.job.id)).toMatchObject({
      status: 'completed',
    });
    expect(JSON.parse(runs.at(-1).input).sender.nickname).toBe('动画成员');
    expect(runs.at(-1).images).toBeUndefined();
  });
  it('inherits plan priority and rejects a pending hunt after mode cancellation', async () => {
    await members.saveModeSettings({ jeropsPrompt: 'special', planPrompt: 'plan' });
    await members.setPlanMembers(chat.id, [member]);
    await members.modeCommand(chat.id, member, 'plan');
    const a = await image();
    expect(a.job.payload.priority).toBe(1);
    expect(a.job.payload.context.mode).toBe('plan');
    await engine.process('reply', a.job.payload, a.job.id);
    expect(runs.at(-1).priority).toBe(1);
    const b = await image(),
      count = runs.length;
    await members.modeCommand(chat.id, member, 'cancel');
    expect(await engine.process('reply', b.job.payload, b.job.id)).toMatchObject({
      status: 'cancelled',
    });
    expect(runs.length).toBe(count);
  });
  it('applies the configured member cooldown across distinct image events', async () => {
    const settings = await getHuntSettings(db);
    await saveHuntSettings(db, { ...settings, cooldownSeconds: 30 });
    // Clear only this fixture's existing reservation to test its first event.
    await db.query('DELETE FROM hunt_cooldowns');
    const a = await image();
    await engine.process('reply', a.job.payload, a.job.id);
    const count = runs.length,
      b = await image();
    expect(await engine.process('reply', b.job.payload, b.job.id)).toMatchObject({
      status: 'skipped',
    });
    expect(runs.length).toBe(count);
    await saveHuntSettings(db, { ...(await getHuntSettings(db)), cooldownSeconds: 0 });
  });
  it('discards a model result after stop and rejects an old send after settings change', async () => {
    const a = await image();
    hold = true;
    const entered = new Promise<void>((r) => (started = r));
    const pending = engine.process('reply', a.job.payload, a.job.id);
    await entered;
    await engine.stopChat(chat.id);
    release();
    hold = false;
    started = () => {};
    expect(await pending).toMatchObject({ status: 'cancelled' });
    expect((await db.query('SELECT id FROM sends WHERE id=$1', [a.job.id])).rowCount).toBe(0);
    const b = await image();
    await engine.process('reply', b.job.payload, b.job.id);
    const settings = await getHuntSettings(db);
    await saveHuntSettings(db, { ...settings, prompt: settings.prompt + ' changed' });
    expect(await engine.process('send', { sendId: b.job.id }, randomUUID())).toMatchObject({
      status: 'cancelled',
    });
    await expect(saveHuntSettings(db, { ...settings, prompt: 'stale' })).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  it('does not revive an image registered before stop when its upload arrives later', async () => {
    const a = await image(member, {}, false);
    await engine.stopChat(chat.id);
    await images.upload(a.upload);
    expect(
      (await db.query('SELECT id FROM outbox WHERE unique_key=$1', ['hunt-' + a.attachmentId]))
        .rowCount,
    ).toBe(0);
    expect((await image()).job).toBeTruthy();
  });
  it('keeps an in-flight reply valid when the same unique profile name has a different cached avatar', async () => {
    const eventId = randomUUID(),
      a = await image(null, {
        eventId,
        uiCandidate: { eventId, name: '外观冲突成员', appearanceHash: 'c'.repeat(64) },
      });
    hold = true;
    const entered = new Promise<void>((r) => (started = r)),
      pending = engine.process('reply', a.job.payload, a.job.id);
    await entered;
    const collision = randomUUID();
    await engine.ingest({
      eventId: collision,
      chatId: chat.id,
      accountId: 'test',
      content: '[图片]',
      type: 'image',
      observedAt: new Date().toISOString(),
      isSelf: false,
      mentioned: false,
      uiCandidate: { eventId: collision, name: '外观冲突成员', appearanceHash: 'd'.repeat(64) },
      image: { attachmentId: randomUUID(), status: 'pending', quality: 'thumbnail' },
    });
    release();
    hold = false;
    started = () => {};
    expect(await pending).toMatchObject({ status: 'completed' });
    expect((await db.query('SELECT id FROM sends WHERE id=$1', [a.job.id])).rowCount).toBe(1);
  });
  it('discards image-dependent model results after retention cleanup or a memory reset', async () => {
    for (const action of ['cleanup', 'reset']) {
      const a = await image();
      hold = true;
      const entered = new Promise<void>((r) => (started = r)),
        pending = engine.process('reply', a.job.payload, a.job.id);
      await entered;
      if (action === 'cleanup') {
        await db.query("UPDATE chat_images SET observed_at=now()-interval '31 days' WHERE id=$1", [
          a.attachmentId,
        ]);
        await images.cleanup();
      } else await resetMemories(db);
      release();
      hold = false;
      started = () => {};
      expect(await pending).toMatchObject({ status: 'cancelled' });
      expect((await db.query('SELECT id FROM sends WHERE id=$1', [a.job.id])).rowCount).toBe(0);
    }
  });
  it('discards an in-flight generation when the owner is added to the whitelist', async () => {
    const a = await image();
    hold = true;
    const entered = new Promise<void>((r) => (started = r)),
      pending = engine.process('reply', a.job.payload, a.job.id);
    try {
      await entered;
      await saveHuntSettings(db, {
        ...(await getHuntSettings(db)),
        whitelist: [{ chatId: chat.id, memberId: member }],
      });
      release();
      expect(await pending).toMatchObject({ status: 'cancelled' });
      expect((await db.query('SELECT id FROM sends WHERE id=$1', [a.job.id])).rowCount).toBe(0);
    } finally {
      release();
      hold = false;
      started = () => {};
      await saveHuntSettings(db, { ...(await getHuntSettings(db)), whitelist: [] });
    }
  });
  it('continues an existing generation after a durable detection replay without resetting its stage', async () => {
    const a = await image();
    const first = await engine.process('hunt-detect', a.job.payload, a.job.id);
    expect(first).toMatchObject({ status: 'completed' });
    await db.query(
      "UPDATE chat_images SET hunt_progress=jsonb_build_object('stage','generating') WHERE id=$1",
      [a.attachmentId],
    );
    expect(await engine.process('hunt-detect', a.job.payload, a.job.id)).toMatchObject({
      status: 'completed',
      replyTaskId: first.replyTaskId,
    });
    expect(
      (await db.query('SELECT hunt_progress FROM chat_images WHERE id=$1', [a.attachmentId]))
        .rows[0].hunt_progress.stage,
    ).toBe('generating');
  });
  it('separates matching from generation and lets another member finish while one model is held', async () => {
    await engine.stopChat(chat.id);
    hold = true;
    const a = await image(),
      b = await image(randomUUID());
    await engine.start();
    const wait = async (check: () => Promise<boolean>) => {
      const until = Date.now() + 12000;
      while (!(await check())) {
        if (Date.now() > until) throw Error('stage wait timed out');
        await engine.flushOutbox();
        await new Promise((r) => setTimeout(r, 30));
      }
    };
    await wait(async () => held.size === 2);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM outbox o JOIN tasks t ON t.id=o.id WHERE o.kind='hunt-reply' AND t.state='running'",
        )
      ).rows[0].n,
    ).toBe(2);
    // One completed model must be sent while the other model remains pending.
    [...held][0]();
    await wait(
      async () =>
        (
          await db.query(
            "SELECT count(*)::int n FROM sends WHERE attachment_id=ANY($1::uuid[]) AND status='sent'",
            [[a.attachmentId, b.attachmentId]],
          )
        ).rows[0].n === 1,
    );
    expect(held.size).toBe(1);
    release();
    hold = false;
    await wait(
      async () =>
        (
          await db.query(
            "SELECT count(*)::int n FROM sends WHERE attachment_id=ANY($1::uuid[]) AND status='sent'",
            [[a.attachmentId, b.attachmentId]],
          )
        ).rows[0].n === 2,
    );
    // Replaying detection cannot duplicate the generation job or delivery.
    await engine.process('hunt-detect', a.job.payload, a.job.id);
    expect(
      (
        await db.query('SELECT count(*)::int n FROM outbox WHERE unique_key=$1', [
          'hunt-generate-' + a.attachmentId,
        ])
      ).rows[0].n,
    ).toBe(1);
  }, 25000);
  it('stops all simultaneously running member replies in the same group', async () => {
    hold = true;
    const a = await image(),
      b = await image(randomUUID());
    const until = Date.now() + 12000;
    while (held.size < 2) {
      if (Date.now() > until) throw Error('parallel start timeout');
      await engine.flushOutbox();
      await new Promise((r) => setTimeout(r, 30));
    }
    const inputs = runs.slice(-2);
    await engine.stopChat(chat.id);
    expect(inputs.every((input) => input.signal.aborted)).toBe(true);
    release();
    hold = false;
    await new Promise((r) => setTimeout(r, 100));
    expect(
      (
        await db.query('SELECT id FROM sends WHERE attachment_id=ANY($1::uuid[])', [
          [a.attachmentId, b.attachmentId],
        ])
      ).rowCount,
    ).toBe(0);
  }, 25000);
});
