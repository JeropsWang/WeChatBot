-- 013_hunt_event_guards：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
-- Never assign today's epoch to a previously registered image after /停止.
-- Existing occurrences are intentionally ineligible for automatic backfill.
ALTER TABLE chat_images ADD COLUMN generation_epoch integer NOT NULL DEFAULT -1;
-- A same-name appearance collision invalidates previously accepted UI evidence,
-- including ordinary members who have never had a manual review record.
ALTER TABLE member_ui_evidence ADD COLUMN evidence_version integer NOT NULL DEFAULT 0;
