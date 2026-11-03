import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Database } from '../apps/server/db.js';
import { MemoryCompactor, scheduleMemoryCompaction } from '../apps/server/memory-compaction.js';
import { MembersService } from '../apps/server/members.js';
import { resetMemories } from '../apps/server/memory-lifecycle.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('agent member memory compaction', () => {
  let db: Database, admin: Database, schema: string;
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    if (url.pathname !== '/liino_test') throw new Error('Requires liino_test');
    schema = 'compact_' + randomUUID().replaceAll('-', '');
    admin = new Database(url.href);
    await admin.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema + ',public');
    db = new Database(url.href);
    await db.migrate();
    const modelId = randomUUID(),
      settings = await db.settings();
    await db.saveSettings({ ...settings, chatModelId: modelId });
    await db.query('INSERT INTO models(id,config) VALUES($1,$2)', [
      modelId,
      {
        id: modelId,
        name: 'fixture',
        protocol: 'openai-compatible',
        model: 'fixture',
        baseUrl: 'http://127.0.0.1',
        contextWindow: 32000,
        supportsTools: false,
      },
    ]);
  });
  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
      await admin.close();
    }
  });
  async function fixture() {
    const chat = await db.createChat({ name: '压缩测试', bindingKey: randomUUID() }),
      memberId = randomUUID();
    await db.query(
      "INSERT INTO members(id,chat_id,number,sender_key,nickname) VALUES($1,$2,1,$3,'群友')",
      [memberId, chat.id, 'ui-profile:' + randomUUID()],
    );
    const memories = [];
    for (const content of [
      '这个成员表示喜欢徒步，周末常去山里走路。',
      '这个成员表示喜欢爬山，周末通常选择户外活动。',
      '这个成员喜欢清淡食物，不太能吃辣，聚餐希望少放辣椒。',
    ])
      memories.push(
        await db.saveMemory({
          content,
          category: '偏好',
          tags: ['兴趣'],
          visibility: 'member',
          scopeChatId: chat.id,
          memberId,
          sourceMessageIds: [randomUUID()],
        }),
      );
    const control = (await db.query('SELECT epoch FROM memory_control WHERE id=1')).rows[0];
    return { chatId: chat.id, memberId, memories, memoryEpoch: control.epoch };
  }
  const agent = (change?: (input: any) => Promise<void>, invalid?: string) => ({
    run: async (input: any) => {
      const data = JSON.parse(input.input);
      await change?.(data);
      return {
        text: JSON.stringify({
          content: invalid ?? '喜欢周末徒步、爬山；饮食清淡，不吃辣。',
          tags: ['户外', '徒步', '清淡饮食'],
          sourceMemoryIds: data.memories.map((m: any) => m.id),
        }),
      };
    },
  });
  const compactor = (gateway: any) =>
    new MemoryCompactor(db, gateway, { get: async () => undefined } as any);
  it('replaces fragments with a tagged impression, preserving evidence and pins', async () => {
    const f = await fixture();
    const pin = await db.saveMemory({
      content: '固定事实',
      category: '事实',
      pinned: true,
      visibility: 'member',
      scopeChatId: f.chatId,
      memberId: f.memberId,
    });
    await compactor(agent()).compact(f, randomUUID());
    const rows = (
      await db.query(
        "SELECT * FROM memories WHERE member_id=$1 AND status='active' ORDER BY pinned",
        [f.memberId],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      content: '喜欢周末徒步、爬山；饮食清淡，不吃辣。',
      tags: ['户外', '徒步', '清淡饮食'],
      subject_key: 'member-impression',
    });
    expect(new Set(rows[0].source_message_ids)).toEqual(
      new Set(f.memories.flatMap((m) => m.sourceMessageIds)),
    );
    expect(rows[1].id).toBe(pin.id);
    expect(
      (
        await db.query('SELECT * FROM memory_versions WHERE memory_id=ANY($1::uuid[])', [
          f.memories.map((m) => m.id),
        ])
      ).rowCount,
    ).toBe(3);
  });
  it('does not commit a snapshot edited during the model call', async () => {
    const f = await fixture();
    await compactor(
      agent(async () => {
        await db.saveMemory({ ...f.memories[0], content: '已修改的事实' });
      }),
    ).compact(f, randomUUID());
    expect(
      (
        await db.query("SELECT * FROM memories WHERE member_id=$1 AND status='active'", [
          f.memberId,
        ])
      ).rowCount,
    ).toBe(3);
  });
  it('rejects an expanded summary without consuming sources', async () => {
    const f = await fixture();
    await expect(
      compactor(agent(undefined, '扩写'.repeat(500))).compact(f, randomUUID()),
    ).rejects.toThrow();
    expect(
      (
        await db.query("SELECT * FROM memories WHERE member_id=$1 AND status='active'", [
          f.memberId,
        ])
      ).rowCount,
    ).toBe(3);
  });
  it('queues existing fragmented member memories once and leaves unrelated members alone', async () => {
    const f = await fixture();
    await scheduleMemoryCompaction(db, f.chatId);
    await scheduleMemoryCompaction(db, f.chatId);
    expect(
      (
        await db.query(
          "SELECT * FROM outbox WHERE kind='memory-compact' AND payload->>'memberId'=$1",
          [f.memberId],
        )
      ).rowCount,
    ).toBe(1);
  });
  it('supports adding ordinary members and editing names without granting trust', async () => {
    const chat = await db.createChat({ name: '管理测试', bindingKey: randomUUID() }),
      service = new MembersService(db);
    const member = await service.create(chat.id, { nickname: '原名' });
    const updated = await service.update(chat.id, member.id, {
      nickname: '新名',
      aliases: ['旧称呼'],
    });
    expect(updated).toMatchObject({
      nickname: '新名',
      aliases: ['旧称呼'],
      identityStatus: 'unknown',
    });
    expect((await service.authorization(chat.id, member.id)).allowed).toBe(false);
    expect(member.identitySource).toBe('unknown');
  });
  it('deletes the member, memories, histories and pending work and permits new identification', async () => {
    const f = await fixture(),
      service = new MembersService(db);
    await compactor(agent()).compact(f, randomUUID());
    const job = await db.enqueue(
      'memory',
      f.chatId,
      { memberId: f.memberId, messageIds: [] },
      randomUUID(),
    );
    await db.query("INSERT INTO member_modes(chat_id,member_id,mode) VALUES($1,$2,'jerops')", [
      f.chatId,
      f.memberId,
    ]);
    await service.remove(f.chatId, f.memberId);
    expect((await db.query('SELECT * FROM members WHERE id=$1', [f.memberId])).rowCount).toBe(0);
    expect(
      (await db.query('SELECT * FROM memories WHERE member_id=$1', [f.memberId])).rowCount,
    ).toBe(0);
    expect((await db.query('SELECT state FROM tasks WHERE id=$1', [job])).rows[0].state).toBe(
      'cancelled',
    );
    const newMember = await service.resolveUiName(f.chatId, '群友', 'a'.repeat(64), 'new-event');
    expect(newMember.status).toBe('matched');
    expect(newMember.memberId).not.toBe(f.memberId);
  });
  it('indexes impression tags even if the tag does not occur in its prose', async () => {
    const f = await fixture();
    await compactor(agent()).compact(f, randomUUID());
    expect(
      (await db.keywordSearch('户外', 8, { chatId: f.chatId, memberId: f.memberId })).some(
        (hit) => hit.content === '喜欢周末徒步、爬山；饮食清淡，不吃辣。',
      ),
    ).toBe(true);
  });
  it('continues large historical batches until all remaining fragments are consolidated', async () => {
    const f = await fixture();
    for (let i = 0; i < 23; i++)
      await db.saveMemory({
        content: `第${i}条个人生活记录，需要保留出处并由模型概括主题。`,
        category: '事实',
        visibility: 'member',
        scopeChatId: f.chatId,
        memberId: f.memberId,
      });
    await compactor(agent()).compact(f, randomUUID());
    expect(
      (
        await db.query(
          "SELECT * FROM outbox WHERE kind='memory-compact' AND payload->>'memberId'=$1",
          [f.memberId],
        )
      ).rowCount,
    ).toBe(1);
    await compactor(agent()).compact(f, randomUUID());
    expect(
      (
        await db.query("SELECT * FROM memories WHERE member_id=$1 AND status='active'", [
          f.memberId,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it('rejects missing or fabricated source IDs and preserves every original', async () => {
    const f = await fixture();
    const gateway = {
      run: async () => ({
        text: JSON.stringify({
          content: '伪造来源的概括',
          tags: ['主题'],
          sourceMemoryIds: [f.memories[0].id, randomUUID()],
        }),
      }),
    };
    await expect(compactor(gateway).compact(f, randomUUID())).rejects.toThrow('来源');
    expect(
      (
        await db.query("SELECT * FROM memories WHERE member_id=$1 AND status='active'", [
          f.memberId,
        ])
      ).rowCount,
    ).toBe(3);
  });
  it('keeps candidate and conflict records out of the model and out of replacement', async () => {
    const f = await fixture();
    for (const status of ['candidate', 'conflicted'] as const)
      await db.saveMemory({
        content: '尚未确认的特征',
        category: '事实',
        status,
        visibility: 'member',
        scopeChatId: f.chatId,
        memberId: f.memberId,
      });
    await compactor(
      agent(async (data) => {
        expect(data.memories).toHaveLength(3);
      }),
    ).compact(f, randomUUID());
    expect(
      (
        await db.query(
          "SELECT * FROM memories WHERE member_id=$1 AND status IN ('candidate','conflicted')",
          [f.memberId],
        )
      ).rowCount,
    ).toBe(2);
  });
  it('does not recreate a member deleted during the agent call or from an old message', async () => {
    const f = await fixture(),
      service = new MembersService(db),
      eventId = randomUUID();
    const messageId = await db.ingest({
      eventId,
      chatId: f.chatId,
      accountId: 'fixture',
      content: '旧消息',
      isSelf: false,
      mentioned: false,
      type: 'text',
      observedAt: new Date().toISOString(),
    });
    await db.query('UPDATE messages SET raw=raw||$2::jsonb WHERE id=$1', [
      messageId,
      JSON.stringify({
        uiIdentityStatus: 'matched',
        uiMemberId: f.memberId,
        identitySource: 'wechat-ui-profile',
      }),
    ]);
    await compactor(
      agent(async () => {
        await service.remove(f.chatId, f.memberId);
      }),
    ).compact(f, randomUUID());
    expect(
      (await db.query('SELECT * FROM memories WHERE member_id=$1', [f.memberId])).rowCount,
    ).toBe(0);
    expect(await service.resolveUiName(f.chatId, '群友', 'a'.repeat(64), eventId)).toMatchObject({
      status: 'unknown',
    });
    expect(
      (await db.query('SELECT * FROM messages WHERE id=$1', [messageId])).rows[0].content,
    ).toBe('旧消息');
  });
  it('cannot resurrect a deleted confirmed UI member using its historical confirmation task', async () => {
    const chat = await db.createChat({ name: '旧确认任务', bindingKey: randomUUID() }),
      service = new MembersService(db),
      eventId = randomUUID();
    await db.ingest({
      eventId,
      chatId: chat.id,
      accountId: 'fixture',
      content: '认人实时测试',
      isSelf: false,
      mentioned: false,
      type: 'text',
      observedAt: new Date().toISOString(),
    });
    const taskId = (await db.enqueue('identity-status', chat.id, { eventId }, randomUUID()))!;
    await db.query("UPDATE tasks SET state='completed',result=$2 WHERE id=$1", [
      taskId,
      { status: 'candidate', name: '已确认后删除', identitySource: 'wechat-ui-profile' },
    ]);
    const member = await service.confirmUiName(chat.id, taskId);
    await service.remove(chat.id, member.id);
    await expect(service.confirmUiName(chat.id, taskId)).rejects.toThrow('没有当前群');
    expect((await service.list(chat.id)).total).toBe(0);
  });
  it('rejects a summary if the member was renamed during the call', async () => {
    const f = await fixture();
    await compactor(
      agent(async () => {
        await new MembersService(db).update(f.chatId, f.memberId, { nickname: '新称呼' });
      }),
    ).compact(f, randomUUID());
    expect(
      (
        await db.query("SELECT * FROM memories WHERE member_id=$1 AND status='active'", [
          f.memberId,
        ])
      ).rowCount,
    ).toBe(3);
  });
  it('can schedule a new task after a rename cancels the old snapshot', async () => {
    const f = await fixture();
    await scheduleMemoryCompaction(db, f.chatId);
    await compactor(
      agent(async () => {
        await new MembersService(db).update(f.chatId, f.memberId, { nickname: '新名字' });
      }),
    ).compact(f, randomUUID());
    await db.query(
      "UPDATE tasks SET state='cancelled' WHERE id IN (SELECT id FROM outbox WHERE kind='memory-compact' AND payload->>'memberId'=$1)",
      [f.memberId],
    );
    await scheduleMemoryCompaction(db, f.chatId);
    expect(
      (
        await db.query(
          "SELECT * FROM outbox o JOIN tasks t USING(id) WHERE o.kind='memory-compact' AND o.payload->>'memberId'=$1 AND t.state='pending'",
          [f.memberId],
        )
      ).rowCount,
    ).toBe(1);
  });
  it('does not starve eligible members behind the first 100 ineligible impressions', async () => {
    const f = await fixture();
    await db.query(
      `INSERT INTO members(id,chat_id,number,sender_key,nickname) SELECT lpad(n::text,32,'0')::uuid,$1,n+1,'ui-profile:'||n,'无需刷新' FROM generate_series(1,100) n`,
      [f.chatId],
    );
    await db.query(
      `INSERT INTO memories(id,content,category,confidence,status,visibility,scope_chat_id,member_id,subject_key,search_text)
      SELECT gen_random_uuid(),'已有印象与一条新片段','事实',1,'active','member',$1,m.id,kind,to_tsvector('simple','记忆')
      FROM members m CROSS JOIN (VALUES ('member-impression'::text),(NULL::text)) kinds(kind) WHERE m.chat_id=$1 AND m.id<>$2`,
      [f.chatId, f.memberId],
    );
    await scheduleMemoryCompaction(db, f.chatId);
    expect(
      (
        await db.query(
          "SELECT * FROM outbox WHERE kind='memory-compact' AND payload->>'memberId'=$1",
          [f.memberId],
        )
      ).rowCount,
    ).toBe(1);
  });
  it('freezes the latest automatic impression again after unpinning', async () => {
    const f = await fixture(),
      service = new MembersService(db);
    await compactor(agent()).compact(f, randomUUID());
    await service.update(f.chatId, f.memberId, { pinned: true });
    await service.update(f.chatId, f.memberId, { pinned: false });
    const impression = (
      await db.query("SELECT * FROM memories WHERE member_id=$1 AND status='active'", [f.memberId])
    ).rows[0];
    await db.saveMemory({ id: impression.id, content: '最新印象：喜欢游泳。', category: '事实' });
    const saved = await service.update(f.chatId, f.memberId, { pinned: true });
    expect(saved.profile.summary).toBe('最新印象：喜欢游泳。');
  });
  it('does not inject obsolete manual facets alongside an automatic impression', async () => {
    const f = await fixture(),
      service = new MembersService(db);
    await service.update(f.chatId, f.memberId, {
      profile: {
        summary: '旧人工画像',
        interests: ['旧兴趣'],
        preferences: ['旧偏好'],
        communication: '旧习惯',
      },
    });
    await compactor(agent()).compact(f, randomUUID());
    const member = await service.detail(f.chatId, f.memberId);
    expect(member.profile).toEqual({ summary: '喜欢周末徒步、爬山；饮食清淡，不吃辣。' });
  });
  it('does not write results from before a full memory reset', async () => {
    const f = await fixture();
    await compactor(
      agent(async () => {
        await resetMemories(db);
      }),
    ).compact(f, randomUUID());
    expect((await db.query('SELECT * FROM memories')).rowCount).toBe(0);
  });
});
