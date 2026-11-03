import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Database } from '../apps/server/db.js';
import { MembersService, parseModeCommand } from '../apps/server/members.js';
import type { IncomingMessage } from '../packages/contracts.js';

describe('anchored personal mode commands', () => {
  it('parses root commands and rejects quoted/code/embedded command text', () => {
    expect(parseModeCommand('#JEROPS 帮我分析')).toEqual({ name: 'jerops', argument: '帮我分析' });
    expect(parseModeCommand('@测试机器人 /plan 周计划', true)).toEqual({
      name: 'plan',
      argument: '周计划',
    });
    expect(parseModeCommand('#CANCEL')).toEqual({ name: 'cancel', argument: '' });
    for (const text of [
      '他说 #JEROPS',
      '> #JEROPS',
      '```\n/plan\n```',
      '「今天 /plan」',
      '#JEROPSx',
      '@测试机器人 /plan',
    ])
      expect(parseModeCommand(text)).toBeNull();
  });
});
describe('UI profile names scoped to a group', () => {
  function fixture(rows: any[] = [], appearances: any[] = []) {
    const writes: string[] = [];
    const member = {
      id: randomUUID(),
      number: 1,
      nickname: '群友',
      identity_status: 'unknown',
      sender_key: 'ui-profile:fixture',
    };
    const client = {
      query: async (sql: string, values: any[] = []) => {
        if (sql.includes('FROM members WHERE chat_id=$1 AND (nickname='))
          return { rows, rowCount: rows.length };
        if (sql.includes('FROM member_ui_evidence'))
          return { rows: appearances, rowCount: appearances.length };
        if (sql.includes('RETURNING member_sequence'))
          return { rows: [{ member_sequence: 1 }], rowCount: 1 };
        if (sql.includes('INSERT INTO members')) {
          writes.push('member');
          return { rows: [{ ...member, id: values[0] }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO member_ui_evidence')) writes.push('evidence');
        return { rows: [{ id: 'chat' }], rowCount: 1 };
      },
    };
    return {
      service: new MembersService({
        tx: async (fn: any) => fn(client),
        invalidateData: async () => {},
      } as any),
      writes,
      member,
    };
  }
  it('creates a normal UI member with independent evidence without verified authorization', async () => {
    const f = fixture(),
      result = await f.service.resolveUiName(randomUUID(), '群友', 'a'.repeat(64), 'event');
    expect(result).toMatchObject({ status: 'matched', number: 1, nickname: '群友' });
    expect(f.writes).toEqual(['member', 'evidence']);
  });
  it('matches a unique existing profile name even when its cached avatar changes', async () => {
    const f = fixture(
      [
        {
          id: randomUUID(),
          number: 2,
          nickname: '群友',
          sender_key: 'ui-profile:fixture',
          identity_status: 'unknown',
        },
      ],
      [{ appearance_hash: 'a'.repeat(64) }],
    );
    expect(
      await f.service.resolveUiName(randomUUID(), '群友', 'b'.repeat(64), 'event'),
    ).toMatchObject({ status: 'matched', memberId: expect.any(String) });
    expect(f.writes).toEqual(['evidence']);
  });
  it('accepts a continuous appearance and fills missing legacy evidence without merging members', async () => {
    const row = {
      id: randomUUID(),
      number: 7,
      nickname: '群友',
      sender_key: 'ui-profile:fixture',
      identity_status: 'unknown',
    };
    for (const hash of [null, 'a'.repeat(64)]) {
      const f = fixture([row], [{ appearance_hash: hash }]);
      expect(await f.service.resolveUiName(randomUUID(), '群友', 'a'.repeat(64))).toMatchObject({
        status: 'matched',
        memberId: row.id,
        number: 7,
      });
      expect(f.writes).toEqual(['evidence']);
    }
  });
  it('does not load a conflicted identity or match known appearance without fresh evidence', async () => {
    const row = {
      id: randomUUID(),
      number: 7,
      nickname: '群友',
      sender_key: 'ui-profile:fixture',
      identity_status: 'unknown',
    };
    const conflicted = fixture([{ ...row, identity_status: 'conflicted' }]);
    expect(
      await conflicted.service.resolveUiName(randomUUID(), '群友', 'a'.repeat(64)),
    ).toMatchObject({ status: 'unknown' });
    const missing = fixture([row], [{ appearance_hash: 'a'.repeat(64) }]);
    expect(await missing.service.resolveUiName(randomUUID(), '群友')).toMatchObject({
      status: 'matched',
      memberId: row.id,
    });
    expect(missing.writes).toEqual(['evidence']);
  });
  it('does not choose between duplicate group names or accept malformed appearance evidence', async () => {
    const f = fixture([{ id: randomUUID() }, { id: randomUUID() }]);
    expect(await f.service.resolveUiName(randomUUID(), '群友', 'a'.repeat(64))).toMatchObject({
      status: 'ambiguous',
    });
    expect(f.writes).toEqual([]);
    await expect(f.service.resolveUiName(randomUUID(), '群友', 'invalid')).rejects.toThrow();
  });
  it('uses the caller transaction for observation instead of opening a nested transaction', async () => {
    const service = new MembersService({
      tx: () => {
        throw new Error('nested transaction');
      },
    } as any);
    const client = {
      query: async (sql: string) =>
        sql.includes('identity_bindings') ? { rows: [], rowCount: 0 } : { rows: [{}], rowCount: 1 },
    };
    const result = await service.observe(
      {
        eventId: randomUUID(),
        chatId: randomUUID(),
        accountId: 'account',
        sourceMessageId: 'message',
        senderId: 'sender',
        nativeChatId: 'native',
        identitySource: 'wechat-database',
        identityStatus: 'verified',
        isSelf: false,
        mentioned: false,
        type: 'text',
        content: '测试',
        observedAt: new Date().toISOString(),
      },
      client as any,
    );
    expect(result).toMatchObject({ memberId: null, identityStatus: 'unknown' });
  });
});
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'verified group members and persistent personal modes',
  () => {
    let db: Database, admin: Database, service: MembersService, schema: string;
    beforeAll(async () => {
      const url = new URL(process.env.TEST_DATABASE_URL!);
      if (url.pathname !== '/liino_test') throw new Error('Requires liino_test');
      schema = 'members_' + randomUUID().replaceAll('-', '');
      admin = new Database(url.href);
      await admin.query('CREATE SCHEMA ' + schema);
      url.searchParams.set('options', '-c search_path=' + schema + ',public');
      db = new Database(url.href);
      await db.migrate();
      service = new MembersService(db);
    });
    afterAll(async () => {
      await db?.close();
      if (admin) {
        if (!/^members_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected schema');
        await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
        await admin.close();
      }
    });
    async function chat() {
      const row = await db.createChat({ name: '成员测试', bindingKey: randomUUID() });
      await db.query(
        "INSERT INTO identity_bindings(chat_id,account_id,native_chat_id,source,approved,verified_at) VALUES($1,'fixture',$2,'wechat-database',true,now())",
        [row.id, row.id],
      );
      return row;
    }
    const event = (chatId: string, senderId: string, name = '相同昵称'): IncomingMessage => ({
      eventId: randomUUID(),
      chatId,
      accountId: 'fixture',
      content: '测试',
      observedAt: new Date().toISOString(),
      sourceMessageId: randomUUID(),
      senderId,
      senderName: name,
      isSelf: false,
      mentioned: false,
      type: 'text',
      identityStatus: 'verified',
      identitySource: 'wechat-database',
      nativeChatId: chatId,
    });
    it('matches UI names only inside the current group without creating identities', async () => {
      const a = await chat(),
        b = await chat();
      const member = await service.observe(event(a.id, 'a', '资料卡名字'));
      expect(await service.matchUiName(a.id, '资料卡名字')).toMatchObject({
        status: 'matched',
        memberId: member.memberId,
      });
      expect(await service.matchUiName(b.id, '资料卡名字')).toMatchObject({ status: 'new' });
      await service.observe(event(a.id, 'a', '改名后'));
      expect(await service.matchUiName(a.id, '资料卡名字')).toMatchObject({
        status: 'matched',
        memberId: member.memberId,
      });
      await service.observe(event(a.id, 'b', '改名后'));
      expect(await service.matchUiName(a.id, '改名后')).toMatchObject({ status: 'ambiguous' });
      expect((await service.list(b.id)).total).toBe(0);
    });
    it('persists an explicitly confirmed UI candidate with a UUID while retaining unknown authorization', async () => {
      const a = await chat(),
        b = await chat(),
        incoming = event(a.id, 'untrusted', 'ignored');
      incoming.content = '认人实时测试';
      await db.ingest(incoming);
      const taskId = (await db.enqueue(
        'identity-status',
        a.id,
        { chatId: a.id, eventId: incoming.eventId },
        randomUUID(),
      ))!;
      await db.query("UPDATE tasks SET state='completed',result=$2 WHERE id=$1", [
        taskId,
        { status: 'candidate', name: '界面成员', identitySource: 'wechat-ui-profile' },
      ]);
      await expect(service.confirmUiName(b.id, taskId)).rejects.toThrow();
      const member = await service.confirmUiName(a.id, taskId);
      expect(member).toMatchObject({
        nickname: '界面成员',
        number: 1,
        identityStatus: 'unknown',
        identitySource: 'wechat-ui-profile',
      });
      expect((await service.confirmUiName(a.id, taskId)).id).toBe(member.id);
      await db.query('DELETE FROM member_profile_versions WHERE member_id=$1', [member.id]);
      await db.query('DELETE FROM tasks WHERE id=$1', [taskId]);
      await db.query('DELETE FROM outbox WHERE id=$1', [taskId]);
      expect((await service.confirmUiName(a.id, taskId)).id).toBe(member.id);
      expect((await service.list(a.id)).total).toBe(1);
      expect(await service.matchUiName(a.id, '界面成员')).toMatchObject({
        status: 'matched',
        memberId: member.id,
      });
      await expect(service.setPlanMembers(a.id, [member.id])).rejects.toThrow('已验证');
      expect(
        (await db.query('SELECT raw FROM messages WHERE event_id=$1', [incoming.eventId])).rows[0]
          .raw.memberId,
      ).toBeNull();
    });
    it('automatically registers UI names per group while refusing collisions and preserving unknown permission', async () => {
      const a = await chat(),
        b = await chat(),
        hash = 'c'.repeat(64);
      const first = await service.resolveUiName(a.id, '新群友', hash, randomUUID());
      const elsewhere = await service.resolveUiName(b.id, '新群友', hash, randomUUID());
      expect(first.status).toBe('matched');
      expect(elsewhere.status).toBe('matched');
      if (first.status !== 'matched' || elsewhere.status !== 'matched')
        throw new Error('UI fixture did not resolve');
      expect(first.memberId).not.toBe(elsewhere.memberId);
      expect(await service.detail(a.id, first.memberId)).toMatchObject({
        identityStatus: 'unknown',
        identitySource: 'wechat-ui-profile',
      });
      expect(await service.modeCommand(a.id, first.memberId, 'plan')).toMatchObject({ ok: false });
      expect(await service.resolveUiName(a.id, '新群友', 'd'.repeat(64))).toMatchObject({
        status: 'matched',
        memberId: first.memberId,
      });
      expect((await service.list(a.id)).total).toBe(1);
    });
    it('fails closed without approved identity evidence and ignores peer-supplied member UUIDs', async () => {
      const a = await chat();
      for (const bad of [event(a.id, 'one'), event(a.id, 'two'), event(a.id, 'three')]) {
        bad.memberId = randomUUID();
        bad.identitySource = 'nickname';
        expect(await service.observe(bad)).toMatchObject({
          memberId: null,
          identityStatus: 'unknown',
        });
      }
      expect((await service.list(a.id)).total).toBe(0);
      const good = event(a.id, 'verified');
      good.memberId = randomUUID();
      const normalized = await service.observe(good);
      expect(normalized.memberId).not.toBe(good.memberId);
      expect(normalized.identityStatus).toBe('verified');
      for (const mutation of [
        { sourceMessageId: null },
        { senderId: null },
        { nativeChatId: '' },
        { accountId: 'other-account' },
        { identityStatus: 'conflicted' as const },
      ])
        expect(
          (await service.observe({ ...event(a.id, 'verified', '冲突昵称'), ...mutation })).memberId,
        ).toBeNull();
      await db.query('UPDATE identity_bindings SET approved=false WHERE chat_id=$1', [a.id]);
      expect((await service.observe(event(a.id, 'verified', '伪造改名'))).memberId).toBeNull();
      expect((await service.detail(a.id, normalized.memberId!)).nickname).toBe('相同昵称');
    });
    it('keeps member UUID over rename, separates same nicknames/chats and never recycles numbers', async () => {
      const a = await chat(),
        b = await chat(),
        first = await service.observe(event(a.id, 'first')),
        second = await service.observe(event(a.id, 'second'));
      const renamed = await service.observe(event(a.id, 'first', '新昵称'));
      expect(renamed.memberId).toBe(first.memberId);
      const detail = await service.detail(a.id, first.memberId!);
      expect(detail).toMatchObject({ number: 1, nickname: '新昵称', aliases: ['相同昵称'] });
      expect((await service.detail(a.id, second.memberId!)).number).toBe(2);
      const elsewhere = await service.observe(event(b.id, 'first'));
      expect(elsewhere.memberId).not.toBe(first.memberId);
      await expect(service.detail(b.id, first.memberId!)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect((await service.list(a.id, { q: '新昵称' })).total).toBe(1);
      expect((await service.list(a.id, { q: '相同昵称' })).total).toBe(2);
      await db.query('DELETE FROM member_profile_versions WHERE member_id=$1', [second.memberId]);
      await db.query('DELETE FROM members WHERE id=$1', [second.memberId]);
      const third = await service.observe(event(a.id, 'third'));
      expect((await service.detail(a.id, third.memberId!)).number).toBe(3);
      expect('senderKey' in detail).toBe(false);
    });
    it('derives profiles only from scoped memory and keeps manual edits, pins, evidence and versions', async () => {
      const a = await chat(),
        b = await chat(),
        member = await service.observe(event(a.id, 'profile'));
      const memory = await db.saveMemory({
        content: '喜欢浅烘咖啡',
        category: '偏好',
        visibility: 'member',
        scopeChatId: a.id,
        memberId: member.memberId!,
      });
      await db.saveMemory({
        content: '其他群不可见',
        category: '事实',
        visibility: 'chat',
        scopeChatId: b.id,
      });
      const source = event(a.id, 'profile');
      source.content = '我喜欢咖啡';
      const observed = await service.observe(source);
      await db.ingest(observed);
      expect((await service.detail(a.id, member.memberId!)).profile.summary).toContain(
        memory.content,
      );
      const updated = await service.update(a.id, member.memberId!, {
        profile: { summary: '手动资料', interests: ['咖啡'] },
        pinned: true,
      });
      expect(updated).toMatchObject({
        profile: { summary: '手动资料', interests: ['咖啡'] },
        pinned: true,
      });
      expect(updated.evidence).toHaveLength(1);
      await db.saveMemory({
        content: '新的自动偏好',
        category: '偏好',
        visibility: 'member',
        scopeChatId: a.id,
        memberId: member.memberId!,
      });
      expect((await service.detail(a.id, member.memberId!)).profile.summary).toBe('手动资料');
      const history = await service.history(a.id, member.memberId!);
      expect(history.length).toBeGreaterThan(0);
      expect(JSON.stringify(history)).not.toContain('sender_key');
    });
    it('enforces two same-chat verified plan members and persists mutually exclusive modes until reset', async () => {
      const a = await chat(),
        b = await chat(),
        ids: string[] = [];
      for (let n = 0; n < 3; n++)
        ids.push((await service.observe(event(a.id, 'mode' + n))).memberId!);
      const foreign = (await service.observe(event(b.id, 'mode'))).memberId!;
      expect(await service.modeCommand(a.id, ids[0], 'jerops')).toMatchObject({ ok: false });
      await service.saveModeSettings({ jeropsPrompt: '认真直接回答', planPrompt: '制定计划' });
      await expect(service.setPlanMembers(a.id, ids)).rejects.toThrow(/2|两/);
      await expect(service.setPlanMembers(a.id, [foreign])).rejects.toThrow(/成员|群/);
      await service.setPlanMembers(a.id, ids.slice(0, 2));
      expect(await service.modeCommand(a.id, ids[2], 'plan')).toMatchObject({ ok: false });
      expect(await service.modeCommand(a.id, ids[0], 'jerops')).toMatchObject({
        ok: true,
        mode: 'jerops',
      });
      expect(await service.modeCommand(a.id, ids[0], 'plan')).toMatchObject({
        ok: true,
        mode: 'plan',
      });
      expect(await new MembersService(db).activeMode(a.id, ids[0])).toEqual({
        mode: 'plan',
        prompt: '制定计划',
      });
      expect(await service.activeMode(b.id, ids[0])).toEqual({ mode: 'normal' });
      expect(await service.modeCommand(a.id, ids[0], 'cancel')).toEqual({
        ok: true,
        mode: 'normal',
      });
      expect(await service.activeMode(a.id, ids[0])).toEqual({ mode: 'normal' });
      await service.modeCommand(a.id, ids[0], 'plan');
      await service.setPlanMembers(a.id, [ids[1]]);
      expect(await service.activeMode(a.id, ids[0])).toEqual({ mode: 'normal' });
      await service.modeCommand(a.id, ids[1], 'jerops');
      await service.resetMode(a.id, ids[1]);
      expect(await service.activeMode(a.id, ids[1])).toEqual({ mode: 'normal' });
      await service.saveModeSettings({ chatId: a.id, jeropsPrompt: null, planPrompt: '群内计划' });
      expect(await service.modeSettings(a.id)).toEqual({
        jeropsPrompt: '认真直接回答',
        planPrompt: '群内计划',
      });
      expect(await service.modeSettings(b.id)).toEqual({
        jeropsPrompt: '认真直接回答',
        planPrompt: '制定计划',
      });
    });
    it('allocates distinct numbers under concurrent observations and paginates/searches member numbers', async () => {
      const a = await chat();
      const results = await Promise.all(
        Array.from({ length: 26 }, (_, n) => service.observe(event(a.id, 'concurrent' + n))),
      );
      expect(new Set(results.map((row) => row.memberId)).size).toBe(26);
      const page = await service.list(a.id, { page: 2 });
      expect(page).toMatchObject({ total: 26, page: 2, pageSize: 20 });
      expect(page.items).toHaveLength(6);
      expect(page.items[0].number).toBe(21);
      expect((await service.list(a.id, { q: '26' })).items[0].number).toBe(26);
      const duplicate = await Promise.all([
        service.observe(event(a.id, 'same')),
        service.observe(event(a.id, 'same')),
      ]);
      expect(duplicate[0].memberId).toBe(duplicate[1].memberId);
    });
    it('freezes derived summary when pinned and rejects unverified mode activation', async () => {
      const a = await chat(),
        observed = await service.observe(event(a.id, 'pin'));
      await db.saveMemory({
        content: '置顶前的偏好',
        category: '偏好',
        visibility: 'member',
        scopeChatId: a.id,
        memberId: observed.memberId!,
      });
      await service.update(a.id, observed.memberId!, { pinned: true });
      await db.saveMemory({
        content: '置顶后的自动偏好',
        category: '偏好',
        visibility: 'member',
        scopeChatId: a.id,
        memberId: observed.memberId!,
      });
      expect((await service.detail(a.id, observed.memberId!)).profile.summary).toBe('置顶前的偏好');
      await service.saveModeSettings({ jeropsPrompt: '已配置', planPrompt: '' });
      await db.query("UPDATE members SET identity_status='unknown' WHERE id=$1", [
        observed.memberId,
      ]);
      expect(await service.modeCommand(a.id, observed.memberId!, 'jerops')).toMatchObject({
        ok: false,
      });
      expect(await service.activeMode(a.id, observed.memberId!)).toEqual({ mode: 'normal' });
    });
  },
);
