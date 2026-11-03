-- 005_usage_cache：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
-- model_calls：记录每次模型调用及重试/轮次用量，支持真实费用统计。
CREATE TABLE IF NOT EXISTS model_calls (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id uuid PRIMARY KEY,
  -- run_id：一次逻辑模型运行的聚合ID；多轮工具调用和重试可归入同次运行。
  run_id uuid NOT NULL,
  -- model_id：调用时的模型配置标识文本；不加FK避免删除配置后历史统计丢失。
  model_id text NOT NULL,
  -- model_name：调用时模型名称快照；后来改名不改变历史报表。
  model_name text NOT NULL,
  -- protocol：模型服务线协议；决定请求/响应适配方式，不是模型名称。
  protocol text NOT NULL,
  -- purpose：chat/preview/decision等调用用途；将用户预览与正式聊天的成本分开。
  purpose text NOT NULL,
  -- task_id：可空任务标识文本；预览等非持久任务可没有该值。
  task_id text,
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id text,
  -- member_id：关联成员ID；涉及身份时必须与同一行的群ID共同校验。
  member_id text,
  -- attempt：本次运行重试次数标记；用于解释失败与重复计费。
  attempt integer NOT NULL,
  -- round：工具循环中的轮次；同一run可有多次厂商请求。
  round integer NOT NULL,
  -- status：处理/审核状态；具体合法值若有SQL CHECK见定义，无CHECK时由业务服务维护。
  status text NOT NULL,
  -- started_at：本次厂商调用开始时间；按它选择统计时间范围。
  started_at timestamptz NOT NULL,
  -- finished_at：本次厂商调用结束时间；与开始时间计算耗时。
  finished_at timestamptz NOT NULL,
  -- usage：厂商实际返回的输入/输出/缓存用量JSON；未知量保持未知。
  usage jsonb NOT NULL,
  -- cost：按价格快照计算的费用；NULL表示缺价格或用量，不能显示为免费。
  cost numeric,
  -- currency：费用计价币种；不能直接跨币种相加。
  currency text,
  -- pricing：调用时的单价快照；后续改价不自动重算历史。
  pricing jsonb,
  -- http_status：可空HTTP响应状态；网络未得到响应时不能伪造200。
  http_status integer
);
CREATE INDEX IF NOT EXISTS model_calls_time_idx ON model_calls(started_at DESC);
CREATE INDEX IF NOT EXISTS model_calls_chat_model_idx ON model_calls(chat_id,model_id,started_at DESC);
-- data_versions：为缓存命名空间提供递增失效版本，避免长期复用过期查询结果。
CREATE TABLE IF NOT EXISTS data_versions(
  -- scope：命名作用域键；区分全局、群或成员命名空间，不能解释为数据库schema。
  scope text PRIMARY KEY,
  -- version：记录或配置的递增版本；使旧索引、快照或任务结果可以被识别为过期。
  version bigint NOT NULL DEFAULT 1
);
