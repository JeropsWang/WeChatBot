-- 016_web_knowledge：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
ALTER TABLE documents ADD COLUMN web_url text;
ALTER TABLE documents ADD COLUMN web_content_hash text;
ALTER TABLE documents ADD COLUMN web_kind text CHECK(web_kind IN ('search','fetch'));
ALTER TABLE documents ADD COLUMN web_retrieved_at timestamptz;
CREATE UNIQUE INDEX documents_web_url ON documents(web_url) WHERE web_url IS NOT NULL;
