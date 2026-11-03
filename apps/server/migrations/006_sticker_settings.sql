-- 006_sticker_settings：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
CREATE TABLE IF NOT EXISTS chat_sticker_settings (
  chat_id uuid PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS sends_one_sticker_per_reply ON sends(parent_id) WHERE kind='sticker';
