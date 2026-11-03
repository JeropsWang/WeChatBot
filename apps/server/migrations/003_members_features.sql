-- 003_members_features：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
ALTER TABLE chats ADD COLUMN IF NOT EXISTS member_sequence integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS members (
  id uuid PRIMARY KEY, chat_id uuid NOT NULL REFERENCES chats(id), number integer NOT NULL,
  sender_key text NOT NULL, nickname text NOT NULL DEFAULT '', aliases jsonb NOT NULL DEFAULT '[]',
  identity_status text NOT NULL DEFAULT 'unknown' CHECK(identity_status IN ('verified','unknown','conflicted')),
  profile jsonb NOT NULL DEFAULT '{}', pinned boolean NOT NULL DEFAULT false, manual_profile boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chat_id,number), UNIQUE(chat_id,sender_key), UNIQUE(chat_id,id)
);
CREATE TABLE IF NOT EXISTS member_profile_versions (
  id bigserial PRIMARY KEY,member_id uuid NOT NULL REFERENCES members(id),version integer NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS identity_bindings (
  chat_id uuid PRIMARY KEY REFERENCES chats(id),account_id text NOT NULL,native_chat_id text NOT NULL,
  source text NOT NULL CHECK(source='wechat-database'),approved boolean NOT NULL DEFAULT false,
  verified_at timestamptz, evidence jsonb NOT NULL DEFAULT '{}', UNIQUE(account_id,native_chat_id)
);
CREATE TABLE IF NOT EXISTS plan_members (
  chat_id uuid NOT NULL REFERENCES chats(id),slot integer NOT NULL CHECK(slot IN (1,2)),member_id uuid NOT NULL,
  PRIMARY KEY(chat_id,slot),UNIQUE(chat_id,member_id),FOREIGN KEY(chat_id,member_id) REFERENCES members(chat_id,id)
);
CREATE TABLE IF NOT EXISTS member_modes (
  chat_id uuid NOT NULL,member_id uuid NOT NULL,mode text NOT NULL CHECK(mode IN ('jerops','plan')),
  updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(chat_id,member_id),
  FOREIGN KEY(chat_id,member_id) REFERENCES members(chat_id,id)
);
CREATE TABLE IF NOT EXISTS mode_settings (scope text PRIMARY KEY,value jsonb NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS foods (
  id uuid PRIMARY KEY,name text NOT NULL,description text NOT NULL DEFAULT '',category text NOT NULL DEFAULT '菜品',
  tags jsonb NOT NULL DEFAULT '[]',enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_foods (
  chat_id uuid NOT NULL REFERENCES chats(id),food_id uuid NOT NULL REFERENCES foods(id),PRIMARY KEY(chat_id,food_id)
);
CREATE TABLE IF NOT EXISTS food_draws (
  id uuid PRIMARY KEY,chat_id uuid NOT NULL REFERENCES chats(id),source_message_id uuid NOT NULL UNIQUE,
  food_id uuid NOT NULL REFERENCES foods(id),food_name text NOT NULL,candidates jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS food_draws_chat_time_idx ON food_draws(chat_id,created_at DESC);
CREATE INDEX IF NOT EXISTS messages_member_evidence_idx ON messages(chat_id,(raw->>'memberId'),seq DESC)
  WHERE direction='in' AND raw->>'identityStatus'='verified';
CREATE TABLE IF NOT EXISTS media_assets (
  id uuid PRIMARY KEY,name text NOT NULL,kind text NOT NULL CHECK(kind IN ('image','gif','native-sticker')),
  mime_type text,file_path text,sha256 text,native_ref jsonb,tags jsonb NOT NULL DEFAULT '{"emotion":[],"scene":[],"intensity":[]}',
  manual_tags boolean NOT NULL DEFAULT false,enabled boolean NOT NULL DEFAULT true,status text NOT NULL DEFAULT 'ready',
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(kind,sha256)
);
ALTER TABLE foods ADD COLUMN IF NOT EXISTS image_asset_id uuid REFERENCES media_assets(id);
ALTER TABLE sends ADD COLUMN IF NOT EXISTS content_kind text NOT NULL DEFAULT 'text';
ALTER TABLE sends ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES media_assets(id);
ALTER TABLE sends ADD COLUMN IF NOT EXISTS parent_id uuid;
ALTER TABLE sends ADD COLUMN IF NOT EXISTS actor_member_id uuid REFERENCES members(id);
CREATE TABLE IF NOT EXISTS data_versions(scope text PRIMARY KEY,version bigint NOT NULL DEFAULT 0);
