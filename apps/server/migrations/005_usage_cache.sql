-- 005_usage_cache：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
CREATE TABLE IF NOT EXISTS model_calls (
  id uuid PRIMARY KEY, run_id uuid NOT NULL, model_id text NOT NULL, model_name text NOT NULL,
  protocol text NOT NULL, purpose text NOT NULL, task_id text, chat_id text, member_id text,
  attempt integer NOT NULL, round integer NOT NULL, status text NOT NULL,
  started_at timestamptz NOT NULL, finished_at timestamptz NOT NULL,
  usage jsonb NOT NULL, cost numeric, currency text, pricing jsonb, http_status integer
);
CREATE INDEX IF NOT EXISTS model_calls_time_idx ON model_calls(started_at DESC);
CREATE INDEX IF NOT EXISTS model_calls_chat_model_idx ON model_calls(chat_id,model_id,started_at DESC);
CREATE TABLE IF NOT EXISTS data_versions(scope text PRIMARY KEY,version bigint NOT NULL DEFAULT 1);
