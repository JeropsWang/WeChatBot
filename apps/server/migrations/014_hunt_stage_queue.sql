-- 014_hunt_stage_queue：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
-- chat_images.hunt_progress：检测/生成等阶段进度JSON；让队列展示真实阶段而不只显示笼统运行中。
ALTER TABLE chat_images ADD COLUMN hunt_progress jsonb NOT NULL DEFAULT '{}';
-- chat_images.hunt_detect_task_id：关联持久检测任务ID；便于按阶段追踪/取消。
ALTER TABLE chat_images ADD COLUMN hunt_detect_task_id uuid;
-- chat_images.hunt_reply_task_id：关联持久回复生成任务ID；与检测任务分离便于调度和重试。
ALTER TABLE chat_images ADD COLUMN hunt_reply_task_id uuid;
CREATE INDEX chat_images_hunt_recent ON chat_images(created_at DESC);
