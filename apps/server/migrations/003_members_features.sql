-- 003_members_features：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
-- chats.member_sequence：本群已分配成员编号计数器；事务内递增避免并发重号。
ALTER TABLE chats ADD COLUMN IF NOT EXISTS member_sequence integer NOT NULL DEFAULT 0;
-- members：按群分配成员编号与身份档案，不跨群按昵称合并。
CREATE TABLE IF NOT EXISTS members (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id uuid PRIMARY KEY,
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid NOT NULL REFERENCES chats(id),
  -- number：群内普通成员展示编号；与chat_id联合唯一，与数据库UUID分离。
  number integer NOT NULL,
  -- sender_key：群内稳定成员键；与chat_id联合唯一，不能仅按昵称认人。
  sender_key text NOT NULL,
  -- nickname：当前群昵称；可变且可能同名，不作为唯一身份。
  nickname text NOT NULL DEFAULT '',
  -- aliases：历史称呼JSON数组；支持检索旧名字，不把同名直接合并。
  aliases jsonb NOT NULL DEFAULT '[]',
  -- identity_status：verified/unknown/conflicted；冲突或未知不能作为个人记忆/权限证明。
  identity_status text NOT NULL DEFAULT 'unknown' CHECK(identity_status IN ('verified','unknown','conflicted')),
  -- profile：成员画像JSON；用于个性化上下文，不等于权限配置。
  profile jsonb NOT NULL DEFAULT '{}',
  -- pinned：是否固定；防止自动整理覆盖或提升展示优先级，不免除显式删除规则。
  pinned boolean NOT NULL DEFAULT false,
  -- manual_profile：是否标记为人工画像；允许业务逻辑区别管理员编辑与自动整理。
  manual_profile boolean NOT NULL DEFAULT false,
  -- version：记录或配置的递增版本；使旧索引、快照或任务结果可以被识别为过期。
  version integer NOT NULL DEFAULT 1,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now(),
  -- updated_at：最近修改时间；用于界面排序及判断快照时效。
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chat_id,number),
  UNIQUE(chat_id,sender_key),
  UNIQUE(chat_id,id)
);
-- member_profile_versions：保存成员档案旧版本与身份确认快照，保留变更依据。
CREATE TABLE IF NOT EXISTS member_profile_versions (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id bigserial PRIMARY KEY,
  -- member_id：关联成员ID；涉及身份时必须与同一行的群ID共同校验。
  member_id uuid NOT NULL REFERENCES members(id),
  -- version：记录或配置的递增版本；使旧索引、快照或任务结果可以被识别为过期。
  version integer NOT NULL,
  -- snapshot：变更前或确认时的JSON快照；便于审计，不随当前记录继续变动。
  snapshot jsonb NOT NULL,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now()
);
-- identity_bindings：记录原生群身份绑定及批准证据，声明来源不等于当前桌面桥接自动具备该能力。
CREATE TABLE IF NOT EXISTS identity_bindings (
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid PRIMARY KEY REFERENCES chats(id),
  -- account_id：微信账户标识；与native_chat_id联合唯一防止相同原生群错误绑定。
  account_id text NOT NULL,
  -- native_chat_id：原生群标识；与界面群名分开，不能由猜测昵称填充。
  native_chat_id text NOT NULL,
  -- source：CHECK只允许wechat-database，记录此绑定来源；不是当前免费UI桥接提供原生数据库身份的保证。
  source text NOT NULL CHECK(source='wechat-database'),
  -- approved：管理员是否批准此绑定；证据存在不自动批准。
  approved boolean NOT NULL DEFAULT false,
  -- verified_at：绑定核验时间；NULL表示尚未记录核验。
  verified_at timestamptz,
  -- evidence：JSON证据快照；用于解释审核或身份判定，不是通用权限令牌。
  evidence jsonb NOT NULL DEFAULT '{}',
  UNIQUE(account_id,native_chat_id)
);
-- plan_members：为每群的两个计划席位关联成员，限制席位和成员重复授权。
CREATE TABLE IF NOT EXISTS plan_members (
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid NOT NULL REFERENCES chats(id),
  -- slot：计划席位编号且仅1或2；复合主键限制每群两个席位。
  slot integer NOT NULL CHECK(slot IN (1,2)),
  -- member_id：关联成员ID；涉及身份时必须与同一行的群ID共同校验。
  member_id uuid NOT NULL,
  PRIMARY KEY(chat_id,slot),
  UNIQUE(chat_id,member_id),
  FOREIGN KEY(chat_id,member_id) REFERENCES members(chat_id,id)
);
-- member_modes：记录成员在本群当前选择的特殊模式。
CREATE TABLE IF NOT EXISTS member_modes (
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid NOT NULL,
  -- member_id：关联成员ID；涉及身份时必须与同一行的群ID共同校验。
  member_id uuid NOT NULL,
  -- mode：jerops/plan特殊模式枚举；按群与成员联合主键记录，不能从其他群借用模式。
  mode text NOT NULL CHECK(mode IN ('jerops','plan')),
  -- updated_at：最近修改时间；用于界面排序及判断快照时效。
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chat_id,member_id),
  FOREIGN KEY(chat_id,member_id) REFERENCES members(chat_id,id)
);
-- mode_settings：按作用域保存特殊模式的配置。
CREATE TABLE IF NOT EXISTS mode_settings (
  -- scope：命名作用域键；区分全局、群或成员命名空间，不能解释为数据库schema。
  scope text PRIMARY KEY,
  -- value：该命名键的JSON配置；字段结构由对应业务服务校验与升级。
  value jsonb NOT NULL DEFAULT '{}'
);
-- foods：保存可抽取菜品与可选图片，和群启用关系分开管理。
CREATE TABLE IF NOT EXISTS foods (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id uuid PRIMARY KEY,
  -- name：显示名称；便于管理员辨认，不能作为稳定身份或权限凭据。
  name text NOT NULL,
  -- description：菜品介绍；供选择和展示，不是执行指令。
  description text NOT NULL DEFAULT '',
  -- category：业务分类；用于筛选与检索组织，不授予权限。
  category text NOT NULL DEFAULT '菜品',
  -- tags：JSON标签集合；支持多维筛选，不把标签当作模型系统指令。
  tags jsonb NOT NULL DEFAULT '[]',
  -- enabled：是否被管理员启用；独立于资源是否存在和当前服务是否可用。
  enabled boolean NOT NULL DEFAULT true,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now(),
  -- updated_at：最近修改时间；用于界面排序及判断快照时效。
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- chat_foods：定义每群实际参与抽签的菜品集合。
CREATE TABLE IF NOT EXISTS chat_foods (
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid NOT NULL REFERENCES chats(id),
  -- food_id：参与该群抽签的菜品外键；与chat_id复合主键防止同群重复启用。
  food_id uuid NOT NULL REFERENCES foods(id),
  PRIMARY KEY(chat_id,food_id)
);
-- food_draws：固化每次抽签的候选与结果，避免重试产生不同菜品。
CREATE TABLE IF NOT EXISTS food_draws (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id uuid PRIMARY KEY,
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid NOT NULL REFERENCES chats(id),
  -- source_message_id：触发抽签的消息ID且唯一；同一输入重试不能重新随机。
  source_message_id uuid NOT NULL UNIQUE,
  -- food_id：抽中的菜品外键；保留对当前菜品的引用。
  food_id uuid NOT NULL REFERENCES foods(id),
  -- food_name：抽签时的名称快照；菜品改名后旧结果仍能解释。
  food_name text NOT NULL,
  -- candidates：抽签时的候选列表JSON；保留随机选择的实际范围。
  candidates jsonb NOT NULL,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS food_draws_chat_time_idx ON food_draws(chat_id,created_at DESC);
CREATE INDEX IF NOT EXISTS messages_member_evidence_idx ON messages(chat_id,(raw->>'memberId'),seq DESC)
  WHERE direction='in' AND raw->>'identityStatus'='verified';
-- media_assets：登记图片、GIF及原生表情的本地资源与分类状态。
CREATE TABLE IF NOT EXISTS media_assets (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id uuid PRIMARY KEY,
  -- name：显示名称；便于管理员辨认，不能作为稳定身份或权限凭据。
  name text NOT NULL,
  -- kind：image/gif/native-sticker由CHECK限定；区分本地字节与原生表情引用。
  kind text NOT NULL CHECK(kind IN ('image','gif','native-sticker')),
  -- mime_type：经过解码核验的媒体类型；决定后续处理，不能只相信文件扩展名。
  mime_type text,
  -- file_path：本地资源路径；数据库只保存位置，备份数据库不等于备份文件。
  file_path text,
  -- sha256：文件字节摘要；用于校验/去重，不证明图片发件人身份。
  sha256 text,
  -- native_ref：可空原生表情引用JSON；无可导出文件时保留桥接识别信息。
  native_ref jsonb,
  -- tags：emotion/scene/intensity等JSON分类；支持按语气与场景选择素材。
  tags jsonb NOT NULL DEFAULT '{"emotion":[],"scene":[],"intensity":[]}',
  -- manual_tags：标签是否由人工维护；自动分类不能无条件覆盖人工决定。
  manual_tags boolean NOT NULL DEFAULT false,
  -- enabled：是否被管理员启用；独立于资源是否存在和当前服务是否可用。
  enabled boolean NOT NULL DEFAULT true,
  -- status：资源处理状态，初始ready；禁用与删除应按业务规则区别。
  status text NOT NULL DEFAULT 'ready',
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now(),
  -- updated_at：最近修改时间；用于界面排序及判断快照时效。
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(kind,sha256)
);
-- foods.image_asset_id：可空素材外键；菜品与图片分别维护，不嵌入二进制。
ALTER TABLE foods ADD COLUMN IF NOT EXISTS image_asset_id uuid REFERENCES media_assets(id);
-- sends.content_kind：text等内容表示方式；发送器按它选择文本/媒体流程。
ALTER TABLE sends ADD COLUMN IF NOT EXISTS content_kind text NOT NULL DEFAULT 'text';
-- sends.asset_id：可选素材ID并有FK；表情/图片发送引用media_assets。
ALTER TABLE sends ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES media_assets(id);
-- sends.parent_id：关联主回复的发件ID；表情作为后续意图关联主回复，列本身没有FK。
ALTER TABLE sends ADD COLUMN IF NOT EXISTS parent_id uuid;
-- sends.actor_member_id：与当前回复有关的成员ID；发送前复查成员模式/身份。
ALTER TABLE sends ADD COLUMN IF NOT EXISTS actor_member_id uuid REFERENCES members(id);
-- data_versions：为缓存命名空间提供递增失效版本，避免长期复用过期查询结果。
CREATE TABLE IF NOT EXISTS data_versions(
  -- scope：命名作用域键；区分全局、群或成员命名空间，不能解释为数据库schema。
  scope text PRIMARY KEY,
  -- version：记录或配置的递增版本；使旧索引、快照或任务结果可以被识别为过期。
  version bigint NOT NULL DEFAULT 0
);
