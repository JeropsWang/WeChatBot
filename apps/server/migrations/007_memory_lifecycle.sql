-- 007_memory_lifecycle：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
-- memory_control：全局单例记忆代次与重置时间，阻止旧任务重新写回已重置记忆。
CREATE TABLE memory_control (
  -- id：全局单例控制行，CHECK(id=1)；让重置和消息接收可以锁同一行协调。
  id integer PRIMARY KEY CHECK(id=1),
  -- epoch：全局记忆代次；重置递增后旧提取/整合任务不能写回。
  epoch integer NOT NULL DEFAULT 0,
  -- reset_at：最近一次重置时间；拒绝迟到的旧事件，初始Postgres epoch表示尚未重置。
  reset_at timestamptz NOT NULL DEFAULT 'epoch',
  -- last_cleanup_at：最近保留期清理时间；支持启动补跑和定时维护。
  last_cleanup_at timestamptz
);
INSERT INTO memory_control(id) VALUES(1);
-- chats.memory_reset_seq：记忆重置时的消息序号边界；旧消息不能重新进入当前记忆/上下文。
ALTER TABLE chats ADD COLUMN memory_reset_seq bigint NOT NULL DEFAULT 0;
-- messages.memory_batch_id：本条消息被哪个记忆批次领取；支撑失败恢复与批次隔离。
ALTER TABLE messages ADD COLUMN memory_batch_id uuid;
-- messages.memory_processed_at：完成记忆处理时间；NULL让未处理记录进入待处理索引。
ALTER TABLE messages ADD COLUMN memory_processed_at timestamptz;
-- sends.payload_expired：正文载荷是否已按保留策略清理；true时账本可留审计但不能重试原内容。
ALTER TABLE sends ADD COLUMN payload_expired boolean NOT NULL DEFAULT false;
-- message_receipts：正文清理后仍保留事件去重凭据，避免重连重传重新入库。
CREATE TABLE message_receipts(
  -- event_id：即使messages正文到期清理仍保留的稳定事件ID；防止同事件再次创建正文。
  event_id text PRIMARY KEY,
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid NOT NULL,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO message_receipts(event_id,chat_id,created_at) SELECT event_id,chat_id,created_at FROM messages ON CONFLICT DO NOTHING;
-- member_ui_evidence：把UI身份证据与画像正文分离，独立失效冲突证据。
CREATE TABLE member_ui_evidence (
  -- member_id：关联成员ID；涉及身份时必须与同一行的群ID共同校验。
  member_id uuid PRIMARY KEY REFERENCES members(id),
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid NOT NULL,
  -- name：本次核验的群昵称；只是证据的一部分，不能只凭此值授权。
  name text NOT NULL,
  -- appearance_hash：可空头像外观精确摘要；防止同名成员共用证据。
  appearance_hash text,
  -- source_event_id：提供证据的入站事件标识；建立当前消息与资料卡的关联。
  source_event_id text,
  -- confirmation：确认任务及证据快照JSON；支持复查，不把候选等同当前有效身份。
  confirmation jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY(chat_id,member_id) REFERENCES members(chat_id,id)
);
INSERT INTO member_ui_evidence(member_id,chat_id,name,confirmation)
SELECT m.id,m.chat_id,(array_agg(v.snapshot->'uiIdentityConfirmation' ORDER BY v.id DESC))[1]->>'name',
  (array_agg(v.snapshot->'uiIdentityConfirmation' ORDER BY v.id DESC))[1] || jsonb_build_object('tasks',jsonb_object_agg(v.snapshot->'uiIdentityConfirmation'->>'taskId',v.snapshot->'uiIdentityConfirmation'))
FROM members m JOIN member_profile_versions v ON v.member_id=m.id
WHERE v.snapshot->'uiIdentityConfirmation'->>'name' IS NOT NULL AND v.snapshot->'uiIdentityConfirmation'->>'taskId' IS NOT NULL GROUP BY m.id,m.chat_id;
CREATE INDEX messages_memory_unprocessed ON messages(chat_id,seq) WHERE direction='in' AND memory_processed_at IS NULL;
CREATE INDEX messages_retention ON messages(created_at,id);
