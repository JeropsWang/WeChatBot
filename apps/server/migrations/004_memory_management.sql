-- 004_memory_management：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
-- Legacy records have no trustworthy visibility or member attribution. Preserve their
-- prior snapshots, content and pins, but quarantine them until an administrator assigns scope.
ALTER TABLE memories ADD COLUMN visibility text;
ALTER TABLE memories ADD COLUMN scope_chat_id uuid REFERENCES chats(id);
ALTER TABLE memories ADD COLUMN member_id uuid;
ALTER TABLE memories ADD CONSTRAINT memory_member_chat FOREIGN KEY(scope_chat_id,member_id) REFERENCES members(chat_id,id);
INSERT INTO memory_versions(memory_id,version,snapshot)
SELECT id,version,to_jsonb(memories) FROM memories WHERE status<>'deleted';
UPDATE memories SET visibility='unassigned',scope_chat_id=source_chat_id,
  status=CASE WHEN status='deleted' THEN 'deleted' ELSE 'candidate' END,
  version=CASE WHEN status='deleted' THEN version ELSE version+1 END,
  embedding=NULL,embedding_version=NULL,updated_at=now();
ALTER TABLE memories ALTER COLUMN visibility SET DEFAULT 'global';
ALTER TABLE memories ALTER COLUMN visibility SET NOT NULL;
ALTER TABLE memories ADD CONSTRAINT memory_visibility CHECK(visibility IN ('global','chat','member','unassigned'));
ALTER TABLE memories ADD CONSTRAINT memory_scope CHECK(
  (visibility='global' AND scope_chat_id IS NULL AND member_id IS NULL) OR
  (visibility='chat' AND scope_chat_id IS NOT NULL AND member_id IS NULL) OR
  (visibility='member' AND scope_chat_id IS NOT NULL AND member_id IS NOT NULL) OR
  (visibility='unassigned' AND member_id IS NULL));
CREATE INDEX memories_scope_idx ON memories(visibility,scope_chat_id,member_id) WHERE status='active';
CREATE INDEX memories_listing_idx ON memories(pinned DESC,updated_at DESC,id) WHERE status<>'deleted';
CREATE TABLE memory_selections (
  token text PRIMARY KEY, snapshot jsonb NOT NULL, expires_at timestamptz NOT NULL,
  deleted_count integer, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_selections_expiry_idx ON memory_selections(expires_at);
CREATE TABLE IF NOT EXISTS data_versions(scope text PRIMARY KEY,version bigint NOT NULL DEFAULT 0);
INSERT INTO data_versions(scope,version) VALUES('knowledge',1),('memory',1)
ON CONFLICT(scope) DO UPDATE SET version=data_versions.version+1;
