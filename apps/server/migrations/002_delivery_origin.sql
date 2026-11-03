-- 002_delivery_origin：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
ALTER TABLE sends ADD COLUMN IF NOT EXISTS origin_at timestamptz;
UPDATE sends SET origin_at=created_at WHERE origin_at IS NULL;
