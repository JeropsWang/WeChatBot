-- 011_chat_images：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
ALTER TABLE chats ADD COLUMN image_sequence integer NOT NULL DEFAULT 0;
ALTER TABLE sends ADD COLUMN attachment_id uuid;
CREATE TABLE chat_images (
 id uuid PRIMARY KEY,chat_id uuid NOT NULL REFERENCES chats(id),message_id uuid NOT NULL UNIQUE,
 event_id text NOT NULL UNIQUE,number integer NOT NULL,owner_member_id uuid,
 status text NOT NULL CHECK(status IN ('pending','ready','unavailable','expired')),
 quality text NOT NULL DEFAULT 'thumbnail',mime_type text,width integer,height integer,sha256 text,file_path text,
 observed_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),reason text,
 UNIQUE(chat_id,number),FOREIGN KEY(chat_id,owner_member_id) REFERENCES members(chat_id,id)
);
CREATE INDEX chat_images_lookup ON chat_images(chat_id,owner_member_id,observed_at DESC);
