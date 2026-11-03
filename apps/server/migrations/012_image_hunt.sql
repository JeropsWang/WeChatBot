-- 012_image_hunt：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
-- chat_images.hunt_result：追猎相似度等结果JSON；分数不是概率，不能凭检测结果授予身份。
ALTER TABLE chat_images ADD COLUMN hunt_result jsonb;
-- chat_images.hunt_checked_at：完成检测的时间；用于区别待检与已有结果。
ALTER TABLE chat_images ADD COLUMN hunt_checked_at timestamptz;
-- sends.hunt_version：生成时追猎设置版本；设置改变后拒绝旧追猎回复。
ALTER TABLE sends ADD COLUMN hunt_version integer;
-- hunt_cooldowns：为每群每成员记录最近一次追猎占用，控制并发与冷却。
CREATE TABLE hunt_cooldowns (
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid NOT NULL REFERENCES chats(id),
  -- member_id：关联成员ID；涉及身份时必须与同一行的群ID共同校验。
  member_id uuid NOT NULL,
  -- task_id：当前占用该冷却槽的任务ID；并发任务不能重复占用同一群成员窗口。
  task_id uuid NOT NULL,
  -- last_trigger_at：最近触发占用时间；计算冷却剩余时间而非用任务完成时间。
  last_trigger_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chat_id,member_id),
  FOREIGN KEY(chat_id,member_id) REFERENCES members(chat_id,id)
);
INSERT INTO settings(key,value) VALUES('hunt',jsonb_build_object(
 'enabled',true,'threshold',0.75,'cooldownSeconds',30,'version',1,'enabledAt',clock_timestamp(),
 'prompt','你正在使用一次性的追猎人格。针对对方刚发匹配表情包这件事，用群内称呼说一句简短、夸张、黑化风格的吐槽，可以使用粗口。不编造真人资料，不作威胁，不牵扯家人，不连续纠缠。只输出这一句回复。'
)) ON CONFLICT DO NOTHING;
