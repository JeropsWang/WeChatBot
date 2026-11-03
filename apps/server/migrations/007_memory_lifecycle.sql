-- 007_memory_lifecycle：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
CREATE TABLE memory_control (
  id integer PRIMARY KEY CHECK(id=1), epoch integer NOT NULL DEFAULT 0,
  reset_at timestamptz NOT NULL DEFAULT 'epoch', last_cleanup_at timestamptz
);
INSERT INTO memory_control(id) VALUES(1);
ALTER TABLE chats ADD COLUMN memory_reset_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN memory_batch_id uuid;
ALTER TABLE messages ADD COLUMN memory_processed_at timestamptz;
ALTER TABLE sends ADD COLUMN payload_expired boolean NOT NULL DEFAULT false;
CREATE TABLE message_receipts(event_id text PRIMARY KEY,chat_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO message_receipts(event_id,chat_id,created_at) SELECT event_id,chat_id,created_at FROM messages ON CONFLICT DO NOTHING;
CREATE TABLE member_ui_evidence (
  member_id uuid PRIMARY KEY REFERENCES members(id),chat_id uuid NOT NULL,
  name text NOT NULL,appearance_hash text,source_event_id text,confirmation jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY(chat_id,member_id) REFERENCES members(chat_id,id)
);
INSERT INTO member_ui_evidence(member_id,chat_id,name,confirmation)
SELECT m.id,m.chat_id,(array_agg(v.snapshot->'uiIdentityConfirmation' ORDER BY v.id DESC))[1]->>'name',
  (array_agg(v.snapshot->'uiIdentityConfirmation' ORDER BY v.id DESC))[1] || jsonb_build_object('tasks',jsonb_object_agg(v.snapshot->'uiIdentityConfirmation'->>'taskId',v.snapshot->'uiIdentityConfirmation'))
FROM members m JOIN member_profile_versions v ON v.member_id=m.id
WHERE v.snapshot->'uiIdentityConfirmation'->>'name' IS NOT NULL AND v.snapshot->'uiIdentityConfirmation'->>'taskId' IS NOT NULL GROUP BY m.id,m.chat_id;
CREATE INDEX messages_memory_unprocessed ON messages(chat_id,seq) WHERE direction='in' AND memory_processed_at IS NULL;
CREATE INDEX messages_retention ON messages(created_at,id);
