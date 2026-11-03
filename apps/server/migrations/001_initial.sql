-- 001_initial：增量数据库结构迁移；按文件顺序执行，由迁移账本防止重复应用。
-- 在独立测试库验证升级后再操作应用库；不得通过清空真实数据解决迁移失败。
CREATE EXTENSION IF NOT EXISTS vector;
-- settings：按命名键保存全局设置与追猎设置，避免把多类配置混成一行。
CREATE TABLE IF NOT EXISTS settings (
  -- key：配置命名键；app与hunt分开存放，以便各自加锁和更新。
  key text PRIMARY KEY,
  -- value：该命名键的JSON配置；字段结构由对应业务服务校验与升级。
  value jsonb NOT NULL
);
-- admins：限制单个本机管理员，并保存单向密码校验材料。
CREATE TABLE IF NOT EXISTS admins (
  -- id：单例管理员主键，CHECK(id=1)使本机只存在一个管理员账户。
  id integer PRIMARY KEY CHECK(id=1),
  -- password_hash：盐与scrypt摘要的组合；用于验证密码，不存明文密码，也不是可逆加密。
  password_hash text NOT NULL
);
-- sessions：保存登录会话摘要及失效时间，不持久保存可直接使用的Cookie令牌。
CREATE TABLE IF NOT EXISTS sessions (
  -- id_hash：会话令牌SHA-256摘要；数据库泄露时不直接暴露可用Cookie，原令牌仅由客户端持有。
  id_hash text PRIMARY KEY,
  -- expires_at：登录会话过期时间；认证时拒绝到期令牌，限制一次登录的有效期。
  expires_at timestamptz NOT NULL
);
-- models：维护可供不同任务选择的模型服务配置，密钥另存密钥库。
CREATE TABLE IF NOT EXISTS models (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id uuid PRIMARY KEY,
  -- config：模型标识、协议、端点、能力和价格JSON；有效API密钥由SecretStore另外存储，不能把apiKey持久写进此JSON。
  config jsonb NOT NULL
);
-- chats：管理群绑定、验收状态与处理游标，使不同群的调度和历史隔离。
CREATE TABLE IF NOT EXISTS chats (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id uuid PRIMARY KEY,
  -- name：显示名称；便于管理员辨认，不能作为稳定身份或权限凭据。
  name text NOT NULL,
  -- binding_key：桥接绑定键且唯一；对应明确选中的群目标，避免按相似名称猜群。
  binding_key text NOT NULL UNIQUE,
  -- enabled：是否被管理员启用；独立于资源是否存在和当前服务是否可用。
  enabled boolean NOT NULL DEFAULT false,
  -- proactive：本群是否允许主动参与；仍受全局暂停、冷却和小时额度约束。
  proactive boolean NOT NULL DEFAULT true,
  -- verified：是否完成真实收发验收；配置了群名或桥接已连接不等于通过验收。
  verified boolean NOT NULL DEFAULT false,
  -- persona：人设JSON；群表保存局部覆盖，空对象意味着沿用全局配置。
  persona jsonb NOT NULL DEFAULT '{}',
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now(),
  -- last_decision_at：最近一次参与判断时间；限制高频调用判断模型，NULL表示尚未判断。
  last_decision_at timestamptz,
  -- last_decision_seq：最近判断覆盖到的消息顺序号；避免对同一批历史反复判断。
  last_decision_seq bigint NOT NULL DEFAULT 0,
  -- memory_cursor：已推进到的记忆提取消息位置；区分已处理与新增聊天。
  memory_cursor bigint NOT NULL DEFAULT 0,
  -- generation_epoch：本群生成代次；暂停或设置改变后递增，发送前拒绝旧代次结果。
  generation_epoch integer NOT NULL DEFAULT 0
);
-- messages：记录收发正文与身份来源，顺序号用于历史窗口和记忆批次。
CREATE TABLE IF NOT EXISTS messages (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id uuid PRIMARY KEY,
  -- seq：全库bigserial顺序号；群内用它排序、分页和设置处理边界，不能当成群内连续计数。
  seq bigserial UNIQUE,
  -- event_id：桥接事件稳定ID且唯一；同一事件重传去重，相同文字不同事件应分别保留。
  event_id text NOT NULL UNIQUE,
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid NOT NULL REFERENCES chats(id),
  -- content：持久正文；供当前记录展示或检索，仍属于需按范围处理的不可信资料。
  content text NOT NULL,
  -- direction：in/out区分收到与自身发出；防止把机器人回声再次触发普通回复。
  direction text NOT NULL CHECK(direction IN ('in','out')),
  -- sender_id：可空的外部发送者ID；桥接未可靠提供时保持NULL，不用昵称伪造。
  sender_id text,
  -- sender_name：可空展示昵称；只用于表达和证据展示，不授予身份权限。
  sender_name text,
  -- mentioned：事件中是否明确@机器人；用于回复优先级与命令路由。
  mentioned boolean NOT NULL DEFAULT false,
  -- observed_at：桥接实际观察到事件的时间；用于过期判断及消息上下文时序。
  observed_at timestamptz NOT NULL,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now(),
  -- state：消息处理进度，初始pending；自发或图片可为observed，取消等后续状态由流水线维护。
  state text NOT NULL DEFAULT 'pending',
  -- raw：事件来源、身份状态、成员候选、图片类型等JSON元数据；保留证据来源，不能把候选直接当verified。
  raw jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS messages_chat_seq ON messages(chat_id,seq);
-- outbox：记录已提交但可能尚未投递到Redis的任务意图，弥合数据库与队列之间的提交空隙。
CREATE TABLE IF NOT EXISTS outbox (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id uuid PRIMARY KEY,
  -- unique_key：稳定业务意图键且唯一；同一任务重试登记不产生第二份意图。
  unique_key text NOT NULL UNIQUE,
  -- kind：业务种类；驱动消费者或资源处理分派，不能与执行状态混用。
  kind text NOT NULL,
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid,
  -- payload：持久JSON载荷；恢复任务/事件所需，不得写入API密钥。
  payload jsonb NOT NULL,
  -- published_at：首次发布登记时间；普通重投不刷新，显式重试可清空；NULL表示待发布，持久意图仍供恢复。
  published_at timestamptz,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now()
);
-- tasks：跟踪每个持久任务执行结果，支撑失败重试与人工排查。
CREATE TABLE IF NOT EXISTS tasks (
  -- id：与outbox.id共用主键且外键关联；一个意图只有一份任务状态。
  id uuid PRIMARY KEY REFERENCES outbox(id),
  -- kind：业务种类；驱动消费者或资源处理分派，不能与执行状态混用。
  kind text NOT NULL,
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid,
  -- state：pending/running/retrying/failed/completed/cancelled等业务状态，SQL无枚举CHECK；不是发送账本状态。
  state text NOT NULL DEFAULT 'pending',
  -- attempts：已执行次数；限制/展示重试，不能直接解释为成功次数。
  attempts integer NOT NULL DEFAULT 0,
  -- error：任务失败的脱敏说明；用于重试或排查，不能保存密钥或完整请求。
  error text,
  -- result：任务执行结果JSON；供后续阶段/运行记录读取，不能仅凭存在就认定消息已发送。
  result jsonb,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now(),
  -- updated_at：最近修改时间；用于界面排序及判断快照时效。
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- sends：维护发件账本与生成时的权限/配置快照，不确定发送不能当作未发送自动重试。
CREATE TABLE IF NOT EXISTS sends (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id uuid PRIMARY KEY,
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid NOT NULL REFERENCES chats(id),
  -- source_message_id：触发消息ID；用于追溯一次行为的输入，字段无FK时不会自动级联删除。
  source_message_id uuid,
  -- content：持久正文；供当前记录展示或检索，仍属于需按范围处理的不可信资料。
  content text NOT NULL,
  -- kind：业务种类；驱动消费者或资源处理分派，不能与执行状态混用。
  kind text NOT NULL,
  -- status：pending/sending/sent/unknown/cancelled等业务状态；not_sent是桥接返回结果，流水线可映射回pending重试而非正常持久状态；unknown须人工核查。
  status text NOT NULL DEFAULT 'pending',
  -- epoch：创建发件时的群generation_epoch；发送前比对当前群代次防止过期结果发出。
  epoch integer NOT NULL,
  -- detail：脱敏发送结果说明；保留不确定或拒绝原因供核查。
  detail text,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now(),
  -- sent_at：确认发送成功的时间；NULL不能被显示为已发。
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS sends_chat_time ON sends(chat_id,created_at);
-- documents：保存导入文档及联网资料的来源、正文和索引状态。
CREATE TABLE IF NOT EXISTS documents (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id uuid PRIMARY KEY,
  -- title：文档展示标题；帮助用户辨认检索结果。
  title text NOT NULL,
  -- source：来源标识；用于追溯资料或证据，不自动赋予可信身份。
  source text NOT NULL,
  -- category：业务分类；用于筛选与检索组织，不授予权限。
  category text NOT NULL DEFAULT '资料',
  -- tags：JSON标签集合；支持多维筛选，不把标签当作模型系统指令。
  tags jsonb NOT NULL DEFAULT '[]',
  -- content：持久正文；供当前记录展示或检索，仍属于需按范围处理的不可信资料。
  content text NOT NULL,
  -- status：文档索引处理状态，初始pending；并非来源事实可信等级。
  status text NOT NULL DEFAULT 'pending',
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now()
);
-- chunks：把文档拆为可单独检索和嵌入的切片，按文档与序号恢复原顺序。
CREATE TABLE IF NOT EXISTS chunks (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id uuid PRIMARY KEY,
  -- document_id：所属documents外键；文档删除时CASCADE清理切片，避免孤立检索结果。
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- content：持久正文；供当前记录展示或检索，仍属于需按范围处理的不可信资料。
  content text NOT NULL,
  -- search_text：为全文检索生成的tsvector；不是原文，GIN索引用于加速词项查询。
  search_text tsvector NOT NULL,
  -- embedding：可选向量；未生成/失效时为NULL，不能与其他模型代次向量混算。
  embedding vector,
  -- embedding_version：生成向量时的嵌入配置代次；用于换模型后识别待重建索引。
  embedding_version integer,
  -- ordinal：在原文的切片序号；与document_id联合唯一，定位片段及恢复相邻顺序。
  ordinal integer NOT NULL,
  UNIQUE(document_id,ordinal)
);
CREATE INDEX IF NOT EXISTS chunks_search_idx ON chunks USING gin(search_text);
-- memories：保存可编辑的长期记忆及其可见范围，与原始聊天正文分开保留。
CREATE TABLE IF NOT EXISTS memories (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id uuid PRIMARY KEY,
  -- content：持久正文；供当前记录展示或检索，仍属于需按范围处理的不可信资料。
  content text NOT NULL,
  -- category：业务分类；用于筛选与检索组织，不授予权限。
  category text NOT NULL,
  -- tags：JSON标签集合；支持多维筛选，不把标签当作模型系统指令。
  tags jsonb NOT NULL DEFAULT '[]',
  -- confidence：提取置信评分；帮助筛选候选，不是经校准的事实正确概率。
  confidence double precision NOT NULL,
  -- status：active/candidate/conflicted/deleted由CHECK约束；只有active进入普通记忆检索。
  status text NOT NULL CHECK(status IN ('active','candidate','conflicted','deleted')),
  -- pinned：是否固定；防止自动整理覆盖或提升展示优先级，不免除显式删除规则。
  pinned boolean NOT NULL DEFAULT false,
  -- version：记录或配置的递增版本；使旧索引、快照或任务结果可以被识别为过期。
  version integer NOT NULL DEFAULT 1,
  -- source_chat_id：来源群外键；表达最初从何得到，与当前可见范围scope_chat_id不是同一含义。
  source_chat_id uuid REFERENCES chats(id),
  -- source_message_ids：来源消息ID的JSON数组；用于溯源，即使正文到期也能保留来源标识。
  source_message_ids jsonb NOT NULL DEFAULT '[]',
  -- source_batch：提取批次标识；与内容MD5形成部分唯一索引，使同批同内容去重。
  source_batch text,
  -- subject_key：记忆主题键，如member-impression；供整合相同主题，不是用户身份凭据。
  subject_key text,
  -- supersedes：被此条替代的旧记忆外键；记录演进关系而非直接覆盖来源。
  supersedes uuid REFERENCES memories(id),
  -- search_text：为全文检索生成的tsvector；不是原文，GIN索引用于加速词项查询。
  search_text tsvector NOT NULL,
  -- embedding：可选向量；未生成/失效时为NULL，不能与其他模型代次向量混算。
  embedding vector,
  -- embedding_version：生成向量时的嵌入配置代次；用于换模型后识别待重建索引。
  embedding_version integer,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now(),
  -- updated_at：最近修改时间；用于界面排序及判断快照时效。
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_batch_content ON memories(source_batch,md5(content)) WHERE source_batch IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_search_idx ON memories USING gin(search_text);
-- memory_versions：保留修改/删除前的记忆版本，支持审计；不是当前检索源。
CREATE TABLE IF NOT EXISTS memory_versions (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id bigserial PRIMARY KEY,
  -- memory_id：原记忆ID，刻意未声明FK；历史不因主记录清理而被级联删除。
  memory_id uuid NOT NULL,
  -- version：记录或配置的递增版本；使旧索引、快照或任务结果可以被识别为过期。
  version integer NOT NULL,
  -- snapshot：变更前或确认时的JSON快照；便于审计，不随当前记录继续变动。
  snapshot jsonb NOT NULL,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now()
);
-- persona_versions：保存人设变化历史，使全局及群覆盖修改可回溯。
CREATE TABLE IF NOT EXISTS persona_versions (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id bigserial PRIMARY KEY,
  -- chat_id：NULL表示全局人设版本；有群ID表示群覆盖版本，未设置FK便于保留独立历史。
  chat_id uuid,
  -- persona：人设JSON；群表保存局部覆盖，空对象意味着沿用全局配置。
  persona jsonb NOT NULL,
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now()
);
-- runtime_logs：保留脱敏运行事件，供定位任务和群级故障。
CREATE TABLE IF NOT EXISTS runtime_logs (
  -- id：稳定记录主键；用于跨表关联，不能以可变显示名称代替。
  id bigserial PRIMARY KEY,
  -- level：日志级别；用于过滤告警和错误。
  level text NOT NULL,
  -- message：简短脱敏事件说明；写入方法限制长度，但不会自动去掉敏感内容。
  message text NOT NULL,
  -- chat_id：归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。
  chat_id uuid,
  -- metadata：结构化日志上下文；便于追踪，写入方负责脱敏，字段本身不会加密。
  metadata jsonb NOT NULL DEFAULT '{}',
  -- created_at：记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。
  created_at timestamptz NOT NULL DEFAULT now()
);
