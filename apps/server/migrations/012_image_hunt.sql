-- 012_image_hunt：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
ALTER TABLE chat_images ADD COLUMN hunt_result jsonb;
ALTER TABLE chat_images ADD COLUMN hunt_checked_at timestamptz;
ALTER TABLE sends ADD COLUMN hunt_version integer;
CREATE TABLE hunt_cooldowns (
 chat_id uuid NOT NULL REFERENCES chats(id),member_id uuid NOT NULL,
 task_id uuid NOT NULL,last_trigger_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(chat_id,member_id),FOREIGN KEY(chat_id,member_id) REFERENCES members(chat_id,id)
);
INSERT INTO settings(key,value) VALUES('hunt',jsonb_build_object(
 'enabled',true,'threshold',0.75,'cooldownSeconds',30,'version',1,'enabledAt',clock_timestamp(),
 'prompt','你正在使用一次性的追猎人格。针对对方刚发匹配表情包这件事，用群内称呼说一句简短、夸张、黑化风格的吐槽，可以使用粗口。不编造真人资料，不作威胁，不牵扯家人，不连续纠缠。只输出这一句回复。'
)) ON CONFLICT DO NOTHING;
