-- 016_web_knowledge：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
-- documents.web_url：规范化来源网址；非NULL时有唯一索引，使重复抓取更新同一文档。
ALTER TABLE documents ADD COLUMN web_url text;
-- documents.web_content_hash：网页有效正文摘要；识别内容变更、避免无变化重复索引。
ALTER TABLE documents ADD COLUMN web_content_hash text;
-- documents.web_kind：search/fetch区分摘要收录与正文读取；使升级正文时不退回低质量摘要。
ALTER TABLE documents ADD COLUMN web_kind text CHECK(web_kind IN ('search','fetch'));
-- documents.web_retrieved_at：本次网页资料取得时间；展示时效而不伪造网页发布日期。
ALTER TABLE documents ADD COLUMN web_retrieved_at timestamptz;
CREATE UNIQUE INDEX documents_web_url ON documents(web_url) WHERE web_url IS NOT NULL;
