-- 004_memory_management：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
-- Legacy records have no trustworthy visibility or member attribution. Preserve their
-- prior snapshots, content and pins, but quarantine them until an administrator assigns scope.
-- memories.visibility：global/chat/member/unassigned；global无群成员归属，chat须群且无成员，member两者必填，unassigned不参与检索。
ALTER TABLE memories ADD COLUMN visibility text;
-- memories.scope_chat_id：当前可见范围对应群；与member_id复合FK确保成员确属该群。
ALTER TABLE memories ADD COLUMN scope_chat_id uuid REFERENCES chats(id);
-- memories.member_id：成员私域归属；仅visibility=member时必填，非成员范围必须NULL。
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
-- memory_selections：冻结批量删除的选择快照，避免确认后按变化的筛选条件误删新记录。
CREATE TABLE memory_selections (
  -- token：冻结选择的随机凭据；后续删除凭它读取既定ID集合，不能重新运行实时筛选。
  token text PRIMARY KEY,
  -- snapshot：固定选择的ID/版本等JSON；使确认数量与实际删除目标一致。
  snapshot jsonb NOT NULL,
  -- expires_at：冻结选择的失效时间；限制删除令牌可被继续使用的期限。
  expires_at timestamptz NOT NULL,
  -- deleted_count：执行后的删除数量；NULL表示尚未记录执行结果，便于幂等反馈。
  deleted_count integer,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_selections_expiry_idx ON memory_selections(expires_at);
-- data_versions：为缓存命名空间提供递增失效版本，避免长期复用过期查询结果。
CREATE TABLE IF NOT EXISTS data_versions(
  -- scope：命名作用域键；区分全局、群或成员命名空间，不能解释为数据库schema。
  scope text PRIMARY KEY,
  -- version：记录或配置的递增版本；使旧索引、快照或任务结果可以被识别为过期。
  version bigint NOT NULL DEFAULT 0
);
INSERT INTO data_versions(scope,version) VALUES('knowledge',1),('memory',1)
ON CONFLICT(scope) DO UPDATE SET version=data_versions.version+1;
