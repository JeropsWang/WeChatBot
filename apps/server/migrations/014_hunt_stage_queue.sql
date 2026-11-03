-- 014_hunt_stage_queue：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
ALTER TABLE chat_images ADD COLUMN hunt_progress jsonb NOT NULL DEFAULT '{}';
ALTER TABLE chat_images ADD COLUMN hunt_detect_task_id uuid;
ALTER TABLE chat_images ADD COLUMN hunt_reply_task_id uuid;
CREATE INDEX chat_images_hunt_recent ON chat_images(created_at DESC);
