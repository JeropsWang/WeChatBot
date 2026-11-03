-- 008_sticker_retry：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
-- A manually rejected delivery is cancelled before a new command is allocated.
-- Retain its parent for auditing while allowing exactly one live sticker intent.
DROP INDEX IF EXISTS sends_one_sticker_per_reply;
CREATE UNIQUE INDEX sends_one_sticker_per_reply ON sends(parent_id)
  WHERE kind='sticker' AND status<>'cancelled';
