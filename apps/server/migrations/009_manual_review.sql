-- 009_manual_review：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
-- member_reviews：维护人工审核当前状态与版本，发送前可复查批准是否仍有效。
CREATE TABLE member_reviews (
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid NOT NULL,
  -- member_id：关联成员ID；涉及身份时必须与同一行的群ID共同校验。
  member_id uuid NOT NULL,
  -- status：approved/revoked/needs-review；审核行不是昵称白名单，发送时还须核对版本。
  status text NOT NULL CHECK(status IN ('approved','revoked','needs-review')),
  -- approval_version：审核代次；撤销或重审后使旧批准与排队结果失效。
  approval_version integer NOT NULL DEFAULT 1,
  -- reviewed_at：最近审核操作时间；用于解释当前批准或撤销的时效。
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  -- evidence：JSON证据快照；用于解释审核或身份判定，不是通用权限令牌。
  evidence jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY(chat_id,member_id),
  FOREIGN KEY(chat_id,member_id) REFERENCES members(chat_id,id)
);
-- member_review_audit：保留审核变化流水，撤销当前权限不抹掉过去操作依据。
CREATE TABLE member_review_audit (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id bigserial PRIMARY KEY,
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid NOT NULL,
  -- member_id：关联成员ID；涉及身份时必须与同一行的群ID共同校验。
  member_id uuid NOT NULL,
  -- status：此次审核动作的状态快照；无枚举CHECK，由审核服务写入并保留历史。
  status text NOT NULL,
  -- approval_version：审核代次；撤销或重审后使旧批准与排队结果失效。
  approval_version integer NOT NULL,
  -- evidence：JSON证据快照；用于解释审核或身份判定，不是通用权限令牌。
  evidence jsonb NOT NULL,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now()
);
