-- 010_reply_priority：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
-- sends.reply_priority：队列优先级快照，默认5；影响调度先后，不授予成员权限。
ALTER TABLE sends ADD COLUMN reply_priority integer NOT NULL DEFAULT 5;
-- sends.review_version：生成时人工审核版本；可空表示不适用，发送前防止批准已撤销。
ALTER TABLE sends ADD COLUMN review_version integer;
-- sends.reply_mode：生成时的normal或特殊模式；供发送前复核当前模式。
ALTER TABLE sends ADD COLUMN reply_mode text NOT NULL DEFAULT 'normal';
-- sends.mode_version：生成时模式配置版本指纹；配置变化后旧回复失效。
ALTER TABLE sends ADD COLUMN mode_version text;
