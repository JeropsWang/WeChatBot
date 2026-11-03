-- 001_initial：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS admins (id integer PRIMARY KEY CHECK(id=1), password_hash text NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id_hash text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS models (id uuid PRIMARY KEY, config jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS chats (
  id uuid PRIMARY KEY, name text NOT NULL, binding_key text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT false, proactive boolean NOT NULL DEFAULT true,
  verified boolean NOT NULL DEFAULT false, persona jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), last_decision_at timestamptz,
  last_decision_seq bigint NOT NULL DEFAULT 0, memory_cursor bigint NOT NULL DEFAULT 0,
  generation_epoch integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY, seq bigserial UNIQUE, event_id text NOT NULL UNIQUE,
  chat_id uuid NOT NULL REFERENCES chats(id), content text NOT NULL,
  direction text NOT NULL CHECK(direction IN ('in','out')), sender_id text, sender_name text,
  mentioned boolean NOT NULL DEFAULT false, observed_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'pending', raw jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS messages_chat_seq ON messages(chat_id,seq);
CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY, unique_key text NOT NULL UNIQUE, kind text NOT NULL, chat_id uuid,
  payload jsonb NOT NULL, published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY REFERENCES outbox(id), kind text NOT NULL, chat_id uuid,
  state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  error text, result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sends (
  id uuid PRIMARY KEY, chat_id uuid NOT NULL REFERENCES chats(id), source_message_id uuid,
  content text NOT NULL, kind text NOT NULL, status text NOT NULL DEFAULT 'pending',
  epoch integer NOT NULL, detail text, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS sends_chat_time ON sends(chat_id,created_at);
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY, title text NOT NULL, source text NOT NULL, category text NOT NULL DEFAULT '资料',
  tags jsonb NOT NULL DEFAULT '[]', content text NOT NULL, status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chunks (
  id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content text NOT NULL, search_text tsvector NOT NULL, embedding vector, embedding_version integer,
  ordinal integer NOT NULL, UNIQUE(document_id,ordinal)
);
CREATE INDEX IF NOT EXISTS chunks_search_idx ON chunks USING gin(search_text);
CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY, content text NOT NULL, category text NOT NULL, tags jsonb NOT NULL DEFAULT '[]',
  confidence double precision NOT NULL, status text NOT NULL CHECK(status IN ('active','candidate','conflicted','deleted')),
  pinned boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
  source_chat_id uuid REFERENCES chats(id), source_message_ids jsonb NOT NULL DEFAULT '[]',
  source_batch text, subject_key text, supersedes uuid REFERENCES memories(id),
  search_text tsvector NOT NULL, embedding vector, embedding_version integer,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_batch_content ON memories(source_batch,md5(content)) WHERE source_batch IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_search_idx ON memories USING gin(search_text);
CREATE TABLE IF NOT EXISTS memory_versions (id bigserial PRIMARY KEY, memory_id uuid NOT NULL, version integer NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS persona_versions (id bigserial PRIMARY KEY, chat_id uuid, persona jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS runtime_logs (id bigserial PRIMARY KEY, level text NOT NULL, message text NOT NULL, chat_id uuid, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
