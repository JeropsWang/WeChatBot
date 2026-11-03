-- 017_hunt_gallery：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
CREATE TABLE hunt_references (
 id text PRIMARY KEY,name text NOT NULL,source text NOT NULL CHECK(source IN ('builtin','upload')),
 category text NOT NULL,path text NOT NULL,crop jsonb,digest text NOT NULL,thumbnail text NOT NULL,
 deleted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hunt_reference_upload_digest ON hunt_references(digest) WHERE source='upload';
CREATE TABLE hunt_galleries(version text PRIMARY KEY,manifest text NOT NULL,reference_ids jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
