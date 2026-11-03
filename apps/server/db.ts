/** PostgreSQL 是持久事实来源：消息、outbox 和状态变更在同一事务提交。迁移按序执行；成员记忆检索必须同时约束群和成员，软删除保留历史。 */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  defaultSettings,
  type AppSettings,
  type Chat,
  type IncomingMessage,
  type KnowledgeHit,
  type MemoryEntry,
  type TaskKind,
} from '../../packages/contracts.js';
import { segmentChinese } from './domain.js';

/** 将 PostgreSQL snake_case 列转换成跨前后端契约的 camelCase。只选公开业务字段，不把群内部游标、epoch 暴露为可编辑设置。 */
export const chatRow = (row: any): Chat => ({
  id: row.id,
  name: row.name,
  bindingKey: row.binding_key,
  enabled: row.enabled,
  proactive: row.proactive,
  verified: row.verified,
  persona: row.persona,
  createdAt: row.created_at,
});
/** 把持久记忆转换为接口条目；source_name 来自 JOIN，手动记录没有来源群时用显示标签兜底，不伪造来源。visibility 与成员/群 ID 必须一起保留，防止调用方丢失可见范围。 */
export const memoryRow = (row: any): MemoryEntry => ({
  id: row.id,
  content: row.content,
  category: row.category,
  tags: row.tags,
  confidence: row.confidence,
  status: row.status,
  pinned: row.pinned,
  version: row.version,
  sourceChatId: row.source_chat_id,
  sourceMessageIds: row.source_message_ids,
  sourceName: row.source_name ?? '手动记录',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  visibility: row.visibility,
  scopeChatId: row.scope_chat_id,
  memberId: row.member_id,
});
export type MemoryScope = { chatId?: string; memberId?: string };
// Member UUIDs are chat-specific. Both the memory scope and the current member row
// must match; a UUID supplied with another chat never grants access.
/** 构造可信 SQL 片段而不是执行查询。alias 与占位符只能来自源码常量，不能传入用户字符串；真实群/成员值仍通过 $n 参数绑定。全局记忆可跨群检索，成员记忆还须验证成员确属该群且具有效身份证据；未归属记忆不进入检索。 */
export const memoryScopeSql = (alias: string, chatParam: string, memberParam: string) =>
  `(${alias}.visibility='global' OR (${alias}.scope_chat_id=${chatParam}::uuid AND
    (${alias}.visibility='chat' OR (${alias}.visibility='member' AND ${alias}.member_id=${memberParam}::uuid
      AND EXISTS(SELECT 1 FROM members scope_member WHERE scope_member.id=${alias}.member_id AND scope_member.chat_id=${chatParam}::uuid AND (scope_member.identity_status='verified' OR scope_member.sender_key LIKE 'ui-profile:%'))))))`;
/** 计算记忆修改会失效的缓存命名空间。移动归属时要同时失效新旧范围，否则旧群仍可能读到过期结果。此版本号用于缓存一致性，不是数据库迁移版本。 */
export const memoryVersionScopes = (row: any): string[] => [
  'knowledge',
  'memory',
  ...(row.scope_chat_id ? ['chat:' + row.scope_chat_id] : []),
  ...(row.member_id ? ['member:' + row.scope_chat_id + ':' + row.member_id] : []),
];
export class Database {
  pool: Pool;
  /** 连接池限制并发与连接/语句等待，避免依赖故障无限占用进程。池的 error 监听防止空闲连接错误成为未处理事件；这不表示查询错误被吞掉，query/tx 仍会拒绝。 */
  constructor(url: string) {
    this.pool = new Pool({
      connectionString: url,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
    });
    this.pool.on('error', () => {});
  }
  /** 所有业务值通过 values 参数绑定，不能把输入拼进 SQL。此薄封装不自动加事务，多条必须原子执行的语句应使用 tx，并使用传入的同一个 PoolClient。 */
  query<T extends QueryResultRow = any>(sql: string, values: any[] = []) {
    return this.pool.query<T>(sql, values);
  }
  /** 从池中借一条专用连接：BEGIN 到 COMMIT/ROLLBACK 都必须走该连接，不能在回调中改用 this.query。回调失败时回滚再抛错；finally 无论成功或异常都 release，避免连接泄漏。这里不提供自动重试或嵌套保存点。 */
  async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  /** 在一个事务里按文件名排序应用未登记迁移。pg_advisory_xact_lock 是事务级咨询锁，只协调同样遵守该锁的迁移执行者，提交/回滚自动释放；它不是全库访问锁。账本只记录文件名与时间，不计算文件内容 checksum，所以不能靠改历史 SQL 更新已安装数据库。新建/改结构须新增迁移；本次只补注释。 */
  async migrate() {
    const directory = fileURLToPath(new URL('./migrations/', import.meta.url));
    await this.tx(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('liino-migrations'))");
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())',
      );
      for (const name of (await readdir(directory)).filter((n) => n.endsWith('.sql')).sort()) {
        if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount)
          continue;
        await client.query(await readFile(directory + '/' + name, 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
      }
      await client.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        'app',
        defaultSettings,
      ]);
    });
  }
  /** 返回配置的深拷贝，避免调用方就地修改共享默认值；尚无记录时使用 defaultSettings。这里是内部读取，API 返回前仍须过滤密钥相关输入字段。 */
  async settings(): Promise<AppSettings> {
    const result = await this.query('SELECT value FROM settings WHERE key=$1', ['app']);
    return structuredClone(result.rows[0]?.value ?? defaultSettings);
  }
  /** FOR UPDATE 锁住唯一 app 配置行，读取、基于旧值更新与写回在同一事务内，避免并发保存丢更新；人设改变时额外保存历史。回调可共享事务更新关联状态，不应持有锁去调用慢速外部服务。 */
  async updateSettings(
    update: (current: AppSettings, client: PoolClient) => Promise<AppSettings> | AppSettings,
  ): Promise<AppSettings> {
    return this.tx(async (c) => {
      const old = (await c.query("SELECT value FROM settings WHERE key='app' FOR UPDATE")).rows[0]
        .value as AppSettings;
      const next = await update(structuredClone(old), c);
      await c.query("UPDATE settings SET value=$1 WHERE key='app'", [next]);
      if (JSON.stringify(old.persona) !== JSON.stringify(next.persona))
        await c.query('INSERT INTO persona_versions(persona) VALUES($1)', [next.persona]);
      return next;
    });
  }
  async saveSettings(value: AppSettings) {
    await this.updateSettings(() => value);
  }
  async chats(): Promise<Chat[]> {
    return (await this.query('SELECT * FROM chats ORDER BY created_at')).rows.map(chatRow);
  }
  async chat(id: string): Promise<Chat | undefined> {
    const row = (await this.query('SELECT * FROM chats WHERE id=$1', [id])).rows[0];
    return row ? chatRow(row) : undefined;
  }
  async createChat(input: { name: string; bindingKey: string }): Promise<Chat> {
    const result = await this.query(
      'INSERT INTO chats(id,name,binding_key) VALUES($1,$2,$3) RETURNING *',
      [randomUUID(), input.name, input.bindingKey],
    );
    return chatRow(result.rows[0]);
  }
  /** 保留数据库中的群 ID，更新设置时递增 generation_epoch，使已排队的旧人设/群状态生成结果失效；同一事务写入人设历史，不能只更新 UI 设置而保留旧任务仍可发送。 */
  async updateChat(id: string, value: Partial<Chat>) {
    const current = await this.chat(id);
    if (!current) throw new Error('群聊不存在');
    const next = { ...current, ...value, id: current.id };
    await this.tx(async (c) => {
      await c.query(
        'UPDATE chats SET name=$2,binding_key=$3,enabled=$4,proactive=$5,persona=$6,generation_epoch=generation_epoch+1 WHERE id=$1',
        [id, next.name, next.bindingKey, next.enabled, next.proactive, next.persona],
      );
      await c.query('INSERT INTO persona_versions(chat_id,persona) VALUES($1,$2)', [
        id,
        next.persona,
      ]);
    });
    return this.chat(id);
  }
  /** 在调用者已有事务中同时写 outbox 意图与 tasks 状态。unique_key 冲突代表同一业务意图已登记，不再建第二个任务；返回 undefined 是已去重，不是“成功创建了新任务”。Redis 发布在后续阶段完成，避免数据库成功但入队失败造成任务永久丢失。 */
  async addJob(c: PoolClient, kind: TaskKind, chatId: string | null, payload: any, key: string) {
    const id = randomUUID();
    const result = await c.query(
      'INSERT INTO outbox(id,unique_key,kind,chat_id,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(unique_key) DO NOTHING RETURNING id',
      [id, key, kind, chatId, payload],
    );
    if (result.rowCount)
      await c.query('INSERT INTO tasks(id,kind,chat_id) VALUES($1,$2,$3)', [id, kind, chatId]);
    return result.rows[0]?.id as string | undefined;
  }
  /** 独立登记一个持久任务；未提供业务 key 时生成随机 key，因此只有显式稳定 key 才能按业务去重。需要与消息入库原子提交时应在同一 tx 内直接调用 addJob。 */
  async enqueue(kind: TaskKind, chatId: string | null, payload: any, key: string = randomUUID()) {
    return this.tx((c) => this.addJob(c, kind, chatId, payload, key));
  }
  /** 接收入站事件。eventId 标识同一次桥接事件，message_receipts 的唯一键用于重连重传去重；相同文字但不同 eventId 必须是两条消息。先持有 memory_control 共享锁，与重置流程协调，再写回执/消息/聊天任务于同一事务。receiptClaimed 只供已在同一事务占有回执的上层调用，不能对普通请求随意设 true。超过30天的消息不重新进入正文与记忆；自发和图片先记 observed，图片另走附件流水线，不创建普通文本 chat 任务。 */
  async ingest(
    event: IncomingMessage,
    client?: PoolClient,
    receiptClaimed = false,
  ): Promise<string | null> {
    const work = async (c: PoolClient) => {
      if (!receiptClaimed) {
        await c.query('SELECT id FROM memory_control WHERE id=1 FOR SHARE');
        const receipt = await c.query(
          'INSERT INTO message_receipts(event_id,chat_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id',
          [event.eventId, event.chatId],
        );
        if (!receipt.rowCount) return null;
      }
      if (Date.parse(event.observedAt) < Date.now() - 30 * 86400000) return null;
      const chat = (
        await c.query('SELECT id,enabled,verified FROM chats WHERE id=$1 FOR SHARE', [event.chatId])
      ).rows[0];
      if (!chat) throw new Error('未知群聊，消息未被接收');
      const id = randomUUID();
      const result = await c.query(
        'INSERT INTO messages(id,event_id,chat_id,content,direction,sender_id,sender_name,mentioned,observed_at,raw,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(event_id) DO NOTHING RETURNING id',
        [
          id,
          event.eventId,
          event.chatId,
          event.content,
          event.isSelf ? 'out' : 'in',
          event.senderId ?? null,
          event.senderName ?? null,
          event.mentioned,
          event.observedAt,
          {
            sourceMessageId: event.sourceMessageId ?? null,
            accountId: event.accountId,
            identityStatus: event.identityStatus ?? 'unknown',
            memberId: event.memberId ?? null,
            nativeChatId: event.nativeChatId ?? null,
            identitySource: event.identitySource ?? null,
            botNickname: event.botNickname ?? null,
            messageType: event.type,
            unresolvedQuote: event.unresolvedQuote ?? false,
            ...(event.uiIdentityFailure
              ? {
                  uiIdentityStatus: 'unknown',
                  uiIdentityReason: event.uiIdentityFailure.reason,
                  uiIdentityReasonCode: event.uiIdentityFailure.reasonCode,
                }
              : {}),
          },
          event.isSelf || event.type === 'image' ? 'observed' : 'pending',
        ],
      );
      if (!result.rowCount) return null;
      if (!event.isSelf && event.type !== 'image')
        await this.addJob(c, 'chat', event.chatId, { messageId: id }, 'chat-' + event.eventId);
      return id;
    };
    return client ? work(client) : this.tx(work);
  }
  /** 先按群、memory_reset_seq 和倒序 LIMIT 取最近记录，再在外层升序恢复对话顺序；直接先升序 LIMIT 会拿到最老消息。成员关联只接受消息中已核验身份或 UI 配对证据，不凭展示昵称拼接画像。 */
  async messages(chatId: string, limit = 50) {
    return (
      await this.query(
        `SELECT * FROM (SELECT m.*,member.number member_number FROM messages m JOIN chats c ON c.id=m.chat_id LEFT JOIN members member ON member.chat_id=m.chat_id AND member.id::text=CASE WHEN m.raw->>'identityStatus'='verified' THEN m.raw->>'memberId' WHEN m.raw->>'uiIdentityStatus'='matched' THEN m.raw->>'uiMemberId' END WHERE m.chat_id=$1 AND m.seq>c.memory_reset_seq ORDER BY m.seq DESC LIMIT $2) recent ORDER BY seq`,
        [chatId, limit],
      )
    ).rows;
  }
  async memories() {
    return (
      await this.query(
        "SELECT m.*,c.name source_name FROM memories m LEFT JOIN chats c ON c.id=m.source_chat_id WHERE m.status<>'deleted' ORDER BY m.pinned DESC,m.updated_at DESC LIMIT 500",
      )
    ).rows.map(memoryRow);
  }
  /** unnest 把绑定的 text[] 展成多行，去重并排序后用 UPSERT 原子递增各命名空间版本。排序使并发事务以一致顺序争用行，降低死锁风险；不直接清空所有缓存。 */
  async invalidateData(c: PoolClient, scopes: string[]) {
    await c.query(
      `INSERT INTO data_versions(scope,version) SELECT scope,1 FROM unnest($1::text[]) scope
      ON CONFLICT(scope) DO UPDATE SET version=data_versions.version+1`,
      [[...new Set(scopes)].sort()],
    );
  }
  /** 锁定旧记忆后按可见范围校验归属，已软删除记录不允许覆盖恢复。旧快照、正文变更、版本递增、向量失效、重建索引任务和缓存版本更新原子提交。共享外部 client 时加入调用方事务；否则自建事务，便于合并记忆复用相同原子边界。JSON.stringify 用于显式绑定 JSON 数组，不能把数组误按 PostgreSQL 数组序列化。 */
  async saveMemory(
    input: Partial<MemoryEntry> & {
      content: string;
      category: string;
      sourceBatch?: string;
      subjectKey?: string | null;
    },
    client?: PoolClient,
  ): Promise<MemoryEntry> {
    const work = async (c: PoolClient) => {
      const id = input.id ?? randomUUID();
      const old = (await c.query('SELECT * FROM memories WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (old?.status === 'deleted') throw new Error('已删除记忆不能覆盖或恢复');
      const visibility = input.visibility ?? old?.visibility ?? 'global';
      const scopeChatId =
        visibility === 'global'
          ? null
          : input.scopeChatId !== undefined
            ? input.scopeChatId
            : (old?.scope_chat_id ?? null);
      const memberId = visibility === 'member' ? (input.memberId ?? old?.member_id ?? null) : null;
      if (
        visibility === 'member' &&
        (!memberId ||
          !scopeChatId ||
          !(
            await c.query('SELECT id FROM members WHERE id=$1 AND chat_id=$2 FOR SHARE', [
              memberId,
              scopeChatId,
            ])
          ).rowCount)
      )
        throw new Error('成员不属于所选群聊');
      if (visibility === 'chat' && !scopeChatId) throw new Error('群记忆必须指定群聊');
      if (old)
        await c.query('INSERT INTO memory_versions(memory_id,version,snapshot) VALUES($1,$2,$3)', [
          id,
          old.version,
          old,
        ]);
      const r = await c.query(
        `INSERT INTO memories(id,content,category,tags,confidence,status,pinned,source_chat_id,source_message_ids,source_batch,subject_key,search_text,visibility,scope_chat_id,member_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_tsvector('simple',$12),$13,$14,$15)
        ON CONFLICT(id) DO UPDATE SET content=EXCLUDED.content,category=EXCLUDED.category,tags=EXCLUDED.tags,confidence=EXCLUDED.confidence,status=EXCLUDED.status,pinned=EXCLUDED.pinned,search_text=EXCLUDED.search_text,visibility=EXCLUDED.visibility,scope_chat_id=EXCLUDED.scope_chat_id,member_id=EXCLUDED.member_id,version=memories.version+1,embedding=NULL,embedding_version=NULL,updated_at=now() RETURNING *`,
        [
          id,
          input.content,
          input.category,
          JSON.stringify(input.tags ?? old?.tags ?? []),
          input.confidence ?? old?.confidence ?? 1,
          input.status ?? old?.status ?? 'active',
          input.pinned ?? old?.pinned ?? false,
          input.sourceChatId ?? old?.source_chat_id ?? null,
          JSON.stringify(input.sourceMessageIds ?? old?.source_message_ids ?? []),
          input.sourceBatch ?? old?.source_batch ?? null,
          input.subjectKey ?? old?.subject_key ?? null,
          segmentChinese(input.content + ' ' + (input.tags ?? old?.tags ?? []).join(' ')),
          visibility,
          scopeChatId,
          memberId,
        ],
      );
      await this.addJob(
        c,
        'index',
        null,
        { memoryId: id },
        'index-memory-' + id + '-' + r.rows[0].version,
      );
      await this.invalidateData(c, [
        ...memoryVersionScopes(r.rows[0]),
        ...(old ? memoryVersionScopes(old) : []),
      ]);
      return memoryRow(r.rows[0]);
    };
    return client ? work(client) : this.tx(work);
  }
  /** 软删除前保存当前版本快照，再移除检索向量并递增版本；正文仍留在历史用于审计，不能当作物理擦除隐私数据。由调用方持有适当行锁并提交事务，本方法本身不会开启事务。 */
  async softDeleteMemories(c: PoolClient, rows: any[]) {
    const ids = rows.filter((row) => row.status !== 'deleted').map((row) => row.id);
    if (!ids.length) return;
    await c.query(
      'INSERT INTO memory_versions(memory_id,version,snapshot) SELECT id,version,to_jsonb(memories) FROM memories WHERE id=ANY($1::uuid[])',
      [ids],
    );
    await c.query(
      "UPDATE memories SET status='deleted',embedding=NULL,embedding_version=NULL,version=version+1,updated_at=now() WHERE id=ANY($1::uuid[])",
      [ids],
    );
    await this.invalidateData(c, rows.flatMap(memoryVersionScopes));
  }
  async softDeleteMemory(c: PoolClient, old: any) {
    await this.softDeleteMemories(c, [old]);
  }
  /** 先锁定目标再执行统一软删除；不存在的 ID 作为幂等空操作返回，不能因此重建记录。 */
  async deleteMemory(id: string) {
    await this.tx(async (c) => {
      const old = (await c.query('SELECT * FROM memories WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (old) await this.softDeleteMemory(c, old);
    });
  }
  /** 按稳定 ID 顺序锁定全部候选，检查数量和可见范围一致后，新建合并记忆并软删除旧记录。保留来源消息并继承任一固定状态；不能跨群或跨成员合并造成检索权限扩散。 */
  async mergeMemories(ids: string[], content: string, category: MemoryEntry['category']) {
    return this.tx(async (c) => {
      const rows = (
        await c.query(
          "SELECT * FROM memories WHERE id=ANY($1::uuid[]) AND status<>'deleted' ORDER BY id FOR UPDATE",
          [ids],
        )
      ).rows;
      if (rows.length !== ids.length) throw new Error('待合并记忆不存在');
      if (!rows.length) throw new Error('请选择待合并记忆');
      const first = rows[0];
      if (
        rows.some(
          (row) =>
            row.visibility !== first.visibility ||
            row.scope_chat_id !== first.scope_chat_id ||
            row.member_id !== first.member_id,
        )
      )
        throw new Error('不能合并不同可见范围的记忆');
      const created = await this.saveMemory(
        {
          content,
          category,
          confidence: 1,
          status: 'active',
          pinned: rows.some((r) => r.pinned),
          sourceMessageIds: [...new Set(rows.flatMap((r) => r.source_message_ids))],
          visibility: first.visibility,
          scopeChatId: first.scope_chat_id,
          memberId: first.member_id,
        },
        c,
      );
      await this.softDeleteMemories(c, rows);
      return created;
    });
  }
  /** 先用中文分词生成 simple tsquery，再联合长期记忆与知识切片。tsvector + GIN 处理词项匹配，ILIKE 兜底子串；反斜杠、百分号、下划线被转义，避免用户搜索词意外扩成通配符。值、范围与 LIMIT 均用占位符；本层不负责向量相似度，向量检索位于 KnowledgeService。记忆仅检索 active 且通过 scope 条件的记录。 */
  async keywordSearch(query: string, limit = 8, scope: MemoryScope = {}): Promise<KnowledgeHit[]> {
    const segmented = segmentChinese(query);
    if (!segmented) return [];
    const result = await this.query(
      `WITH q AS (SELECT plainto_tsquery('simple',$1) term)
      SELECT m.id,m.content,'记忆 · '||m.category title,coalesce(c.name,'手动记录') source,ts_rank(m.search_text,q.term)+CASE WHEN m.pinned THEN 1 ELSE 0 END score,'memory' kind,m.version FROM memories m LEFT JOIN chats c ON c.id=m.source_chat_id,q WHERE m.status='active' AND ${memoryScopeSql('m', '$4', '$5')} AND (m.search_text @@ q.term OR m.content ILIKE $2)
      UNION ALL SELECT k.id,k.content,d.title,d.source,ts_rank(k.search_text,q.term) score,'knowledge' kind,NULL::integer version FROM chunks k JOIN documents d ON d.id=k.document_id,q WHERE k.search_text @@ q.term OR k.content ILIKE $2 ORDER BY score DESC LIMIT $3`,
      [
        segmented,
        '%' + query.replace(/[\\%_]/g, '\\$&') + '%',
        limit,
        scope.chatId ?? null,
        scope.memberId ?? null,
      ],
    );
    return result.rows;
  }
  /** 日志只截短标题，metadata 并不会自动脱敏；调用方必须先移除密钥和真实聊天敏感信息，不能把完整模型请求直接传入。 */
  async log(
    level: string,
    message: string,
    chatId: string | null = null,
    metadata: Record<string, unknown> = {},
  ) {
    await this.query(
      'INSERT INTO runtime_logs(level,message,chat_id,metadata) VALUES($1,$2,$3,$4)',
      [level, message.slice(0, 1000), chatId, metadata],
    );
  }
  /** 关闭池并等待占用连接释放；这是资源清理，不会删除数据库数据，应在工作进程与未完成业务任务停止后调用。 */
  close() {
    return this.pool.end();
  }
}
