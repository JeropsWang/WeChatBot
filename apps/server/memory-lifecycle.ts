/** 维护记忆重置代际和聊天正文保留期限。清理正文不删除长期记忆；事务与游标防止迟到旧消息重建已清空的记忆。 */
import type { Database } from './db.js';

export interface MemoryBatchPayload {
  chatId: string;
  memberId: string;
  messageIds: string[];
  memoryEpoch: number;
}
// This is personalization evidence, never authorization for privileged commands.
export const resolvedMemberSql = (alias = 'm') =>
  `CASE WHEN ${alias}.raw->>'identityStatus'='verified' THEN ${alias}.raw->>'memberId' WHEN ${alias}.raw->>'uiIdentityStatus'='matched' AND ${alias}.raw->>'identitySource'='wechat-ui-profile' THEN ${alias}.raw->>'uiMemberId' END`;
export function selectMemoryMessages<T extends { content: string }>(rows: T[]): T[] {
  const selected: T[] = [];
  let length = 0;
  for (const row of rows) {
    if (selected.length >= 50 || length + row.content.length > 16000) break;
    selected.push(row);
    length += row.content.length;
  }
  return selected;
}
export function cleanupSlot(now: Date): Date {
  const shifted = new Date(now.getTime() + 8 * 3600000);
  const slot =
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 4) -
    8 * 3600000;
  return new Date(slot > now.getTime() ? slot - 86400000 : slot);
}

export async function scheduleMemoryBatches(db: Database, chatId: string): Promise<void> {
  await db.tx(async (c) => {
    const control = (await c.query('SELECT * FROM memory_control WHERE id=1 FOR SHARE')).rows[0];
    const chat = (await c.query('SELECT * FROM chats WHERE id=$1 FOR UPDATE', [chatId])).rows[0];
    if (!chat) return;
    const rows = (
      await c.query(
        `SELECT m.*,member.id actor FROM messages m JOIN members member ON member.id::text=${resolvedMemberSql()} AND member.chat_id=m.chat_id
      WHERE m.chat_id=$1 AND m.direction='in' AND m.state<>'pending' AND m.memory_batch_id IS NULL AND m.memory_processed_at IS NULL
      AND m.seq>$2 AND m.observed_at>$3 AND m.created_at>now()-interval '30 days'
      AND ((m.raw->>'identityStatus'='verified' AND member.identity_status='verified') OR (m.raw->>'uiIdentityStatus'='matched' AND (member.identity_status='verified' OR member.sender_key LIKE 'ui-profile:%')))
      ORDER BY m.seq LIMIT 500 FOR UPDATE OF m`,
        [chatId, chat.memory_reset_seq, control.reset_at],
      )
    ).rows;
    const groups = new Map<string, any[]>();
    for (const row of rows) {
      const list = groups.get(row.actor) ?? [];
      list.push(row);
      groups.set(row.actor, list);
    }
    for (const [memberId, list] of groups) {
      if (list.length < 20 && Date.now() - new Date(list[0].created_at).getTime() < 300000)
        continue;
      const selected = selectMemoryMessages(list);
      if (!selected.length) continue;
      const payload: MemoryBatchPayload = {
        chatId,
        memberId,
        messageIds: selected.map((row) => row.id),
        memoryEpoch: control.epoch,
      };
      const id = await db.addJob(
        c,
        'memory',
        chatId,
        payload,
        'memory-' + control.epoch + '-' + memberId + '-' + selected[0].id,
      );
      if (id)
        await c.query('UPDATE messages SET memory_batch_id=$1 WHERE id=ANY($2::uuid[])', [
          id,
          payload.messageIds,
        ]);
    }
  });
}

export async function resetMemories(db: Database) {
  return db.tx(async (c) => {
    await c.query('SELECT id FROM memory_control WHERE id=1 FOR UPDATE');
    await c.query('SELECT id FROM chats ORDER BY id FOR UPDATE');
    const before = (
      await c.query(
        'SELECT (SELECT count(*)::int FROM memories) memories,(SELECT count(*)::int FROM members) members',
      )
    ).rows[0];
    await c.query('UPDATE memory_control SET epoch=epoch+1,reset_at=clock_timestamp() WHERE id=1');
    await c.query(
      'UPDATE chats c SET memory_reset_seq=(SELECT coalesce(max(seq),0) FROM messages WHERE chat_id=c.id),memory_cursor=(SELECT coalesce(max(seq),0) FROM messages WHERE chat_id=c.id),generation_epoch=generation_epoch+1',
    );
    await c.query(
      "UPDATE tasks SET state='cancelled',result=NULL,error=NULL,updated_at=now() WHERE kind IN ('memory','memory-compact','chat','route','reply','hunt-detect','hunt-reply','proactive') AND state IN ('pending','running','retrying','failed')",
    );
    await c.query(
      "UPDATE tasks SET result=NULL,error=NULL WHERE kind IN ('memory','memory-compact')",
    );
    await c.query(
      "UPDATE sends SET status='cancelled',detail='记忆重置，取消旧回复' WHERE status='pending' AND kind<>'admin-test'",
    );
    await c.query('DELETE FROM memory_versions');
    await c.query('DELETE FROM memory_selections');
    await c.query('UPDATE memories SET supersedes=NULL');
    await c.query('DELETE FROM memories');
    await c.query('DELETE FROM member_profile_versions');
    await c.query('DELETE FROM member_modes');
    await c.query(
      "UPDATE members SET profile='{}',pinned=false,manual_profile=false,version=version+1,updated_at=now()",
    );
    await db.invalidateData(c, [
      'knowledge',
      'memory',
      'members',
      ...(await c.query('SELECT id FROM chats')).rows.map((x) => 'chat:' + x.id),
    ]);
    await c.query(
      "INSERT INTO runtime_logs(level,message,metadata) VALUES('info','全部记忆及用户画像已重置',$1)",
      [{ deletedMemories: before.memories, preservedMembers: before.members }],
    );
    return { deletedMemories: before.memories, preservedMembers: before.members };
  });
}

export class MemoryRetentionService {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private db: Database,
    private cleanupAttachments?: () => Promise<unknown>,
  ) {}
  private async tick() {
    try {
      await this.run();
    } catch (error) {
      await this.db
        .log('error', '聊天正文定时清理失败', undefined, {
          reason: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
        })
        .catch(() => {});
    }
  }
  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 60000);
    this.timer.unref();
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  async run(now = new Date()): Promise<{ messages: number; sends: number } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const cleanupResult = await this.db.tx(async (c) => {
        const control = (await c.query('SELECT * FROM memory_control WHERE id=1 FOR UPDATE'))
          .rows[0];
        const slot = cleanupSlot(now);
        if (control.last_cleanup_at && new Date(control.last_cleanup_at) >= slot) return null;
        const cutoff = new Date(now.getTime() - 30 * 86400000);
        await c.query('SELECT id FROM chats ORDER BY id FOR UPDATE');
        // All epochs change when stale work is cancelled, so an in-flight answer cannot reintroduce its body.
        await c.query(
          `UPDATE chats SET generation_epoch=generation_epoch+1 WHERE id IN (SELECT chat_id FROM messages WHERE created_at<$1)`,
          [cutoff],
        );
        await c.query(
          "UPDATE tasks SET state=CASE WHEN state IN ('pending','running','retrying','failed') THEN 'cancelled' ELSE state END,result=NULL,error=NULL,updated_at=now() WHERE created_at<$1",
          [cutoff],
        );
        await c.query("UPDATE outbox SET payload='{}'::jsonb WHERE created_at<$1", [cutoff]);
        await c.query(
          'INSERT INTO message_receipts(event_id,chat_id,created_at) SELECT event_id,chat_id,created_at FROM messages WHERE created_at<$1 ON CONFLICT DO NOTHING',
          [cutoff],
        );
        await c.query(
          `UPDATE tasks t SET state=CASE WHEN state IN ('pending','running','retrying','failed') THEN 'cancelled' ELSE state END,result=NULL,error=NULL,updated_at=now()
        FROM outbox o WHERE t.id=o.id AND (o.payload->>'messageId' IN (SELECT id::text FROM messages WHERE created_at<$1)
        OR o.payload->>'sendId' IN (SELECT id::text FROM sends WHERE created_at<$1 OR source_message_id IN (SELECT id FROM messages WHERE created_at<$1)))`,
          [cutoff],
        );
        const sends = await c.query(
          "UPDATE sends SET content='',detail='正文已按30天保留规则清理',payload_expired=true,status=CASE WHEN status='pending' THEN 'cancelled' WHEN status='sending' THEN 'unknown' ELSE status END WHERE (created_at<$1 OR source_message_id IN (SELECT id FROM messages WHERE created_at<$1)) AND NOT payload_expired",
          [cutoff],
        );
        const messages = await c.query('DELETE FROM messages WHERE created_at<$1', [cutoff]);
        await c.query('DELETE FROM runtime_logs WHERE created_at<$1', [cutoff]);
        await c.query('DELETE FROM memory_selections WHERE expires_at<now()');
        await c.query('UPDATE memory_control SET last_cleanup_at=$1 WHERE id=1', [now]);
        const result = { messages: messages.rowCount ?? 0, sends: sends.rowCount ?? 0 };
        await c.query(
          "INSERT INTO runtime_logs(level,message,metadata) VALUES('info','30天聊天正文清理完成',$1)",
          [result],
        );
        return result;
      });
      await this.cleanupAttachments?.();
      return cleanupResult;
    } finally {
      this.running = false;
    }
  }
}
