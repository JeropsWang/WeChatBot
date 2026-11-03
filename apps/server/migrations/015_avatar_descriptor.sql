-- 015_avatar_descriptor：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
-- Keep exact live-row evidence separate from render-tolerant appearance checks.
ALTER TABLE member_ui_evidence ADD COLUMN appearance_descriptor jsonb;
