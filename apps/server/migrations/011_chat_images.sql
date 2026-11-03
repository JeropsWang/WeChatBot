-- 011_chat_images：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
-- chats.image_sequence：本群图片编号计数器；分配I开头展示编号时避免重复。
ALTER TABLE chats ADD COLUMN image_sequence integer NOT NULL DEFAULT 0;
-- sends.attachment_id：关联原聊天图片ID；追猎/识图追溯来源，列未声明FK。
ALTER TABLE sends ADD COLUMN attachment_id uuid;
-- chat_images：登记消息中的每次图片出现及处理进度，图片字节与事件身份不混同。
CREATE TABLE chat_images (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id uuid PRIMARY KEY,
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid NOT NULL REFERENCES chats(id),
  -- message_id：对应messages.id且唯一；列未声明FK，以业务生命周期协调清理。
  message_id uuid NOT NULL UNIQUE,
  -- event_id：图片发生事件的稳定ID且唯一；不能用文件摘要替代，否则同图多次发送会被误去重。
  event_id text NOT NULL UNIQUE,
  -- number：群内显示编号；与chat_id联合唯一，便于用户引用而不暴露UUID。
  number integer NOT NULL,
  -- owner_member_id：可空图片成员归属；复合FK保证归属不跨群，未知保持NULL。
  owner_member_id uuid,
  -- status：pending/ready/unavailable/expired；就绪才可读取，过期/不可用不伪造识别结果。
  status text NOT NULL CHECK(status IN ('pending','ready','unavailable','expired')),
  -- quality：thumbnail等取得质量；标明UI截图不等于原始高清图片。
  quality text NOT NULL DEFAULT 'thumbnail',
  -- mime_type：经过解码核验的媒体类型；决定后续处理，不能只相信文件扩展名。
  mime_type text,
  -- width：真实解码宽度像素；结合高度限制资源消耗。
  width integer,
  -- height：真实解码高度像素；不能只相信上传方声明。
  height integer,
  -- sha256：文件字节摘要；用于校验/去重，不证明图片发件人身份。
  sha256 text,
  -- file_path：本地资源路径；数据库只保存位置，备份数据库不等于备份文件。
  file_path text,
  -- observed_at：桥接实际观察到事件的时间；用于过期判断及消息上下文时序。
  observed_at timestamptz NOT NULL,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now(),
  -- reason：不可用/过期原因；供运行记录解释，不保存敏感原始异常。
  reason text,
  UNIQUE(chat_id,number),
  FOREIGN KEY(chat_id,owner_member_id) REFERENCES members(chat_id,id)
);
CREATE INDEX chat_images_lookup ON chat_images(chat_id,owner_member_id,observed_at DESC);
