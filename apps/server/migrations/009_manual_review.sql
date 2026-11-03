-- 009_manual_review：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
CREATE TABLE member_reviews (
  chat_id uuid NOT NULL,member_id uuid NOT NULL,status text NOT NULL CHECK(status IN ('approved','revoked','needs-review')),
  approval_version integer NOT NULL DEFAULT 1,reviewed_at timestamptz NOT NULL DEFAULT now(),
  evidence jsonb NOT NULL DEFAULT '{}',PRIMARY KEY(chat_id,member_id),
  FOREIGN KEY(chat_id,member_id) REFERENCES members(chat_id,id)
);
CREATE TABLE member_review_audit (
  id bigserial PRIMARY KEY,chat_id uuid NOT NULL,member_id uuid NOT NULL,status text NOT NULL,
  approval_version integer NOT NULL,evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
