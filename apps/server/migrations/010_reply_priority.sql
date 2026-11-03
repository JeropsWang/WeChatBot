-- 010_reply_priority：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
ALTER TABLE sends ADD COLUMN reply_priority integer NOT NULL DEFAULT 5;
ALTER TABLE sends ADD COLUMN review_version integer;
ALTER TABLE sends ADD COLUMN reply_mode text NOT NULL DEFAULT 'normal';
ALTER TABLE sends ADD COLUMN mode_version text;
