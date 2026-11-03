# 数据库字段与设计说明

此字典对应 PostgreSQL 迁移 001–017 加 `db.ts` 动态创建的迁移账本；SQLite 在文末。**本次仅修改源码注释/排版，不执行数据库变更，不新增字段，也不修改历史迁移的可执行 SQL。**

PostgreSQL 定义栏保留类型、空值约束、默认值、内联外键及 CHECK。PostgreSQL 的 `PRIMARY KEY` 隐含非空；没有 `NOT NULL` 的普通列可空；没有 DEFAULT 就不应假设程序或数据库会自动补值。没有声明 FK 的关联仅为业务关联，不具有自动引用完整性或级联行为。跨列约束与索引另列于各表。

## 读表时先区分这些概念

- `source_chat_id` 是资料出处，`scope_chat_id` 是读取边界；来自某群不意味着只能或可以被该群读取。
- `generation_epoch` 是群回复代次，`memory_control.epoch` 是全局记忆代次，`version` 可表示配置或内容版本，不能互相替代。
- 消息正文可到期清理；`message_receipts` 和发件账本可继续留存去重/核查信息。软删除与版本快照不等于物理抹除，也不删除离线备份。
- outbox 是持久意图，tasks 是执行状态，sends 是真实发送账本；任务完成不等于微信已成功送达。
- 管理员密码保存盐+scrypt摘要，会话保存令牌SHA-256摘要，服务API密钥由文件密钥库保护；`models.config`、`settings.value` 不应保存有效明文API密钥。

## PostgreSQL逐字段字典

### `settings`

按命名键保存全局设置与追猎设置，避免把多类配置混成一行。

| 字段    | 类型与数据库约束       | 含义与设计目的                                         |
| ------- | ---------------------- | ------------------------------------------------------ |
| `key`   | `key text PRIMARY KEY` | 配置命名键；app与hunt分开存放，以便各自加锁和更新。    |
| `value` | `value jsonb NOT NULL` | 该命名键的JSON配置；字段结构由对应业务服务校验与升级。 |

### `admins`

限制单个本机管理员，并保存单向密码校验材料。

| 字段            | 类型与数据库约束                     | 含义与设计目的                                                     |
| --------------- | ------------------------------------ | ------------------------------------------------------------------ |
| `id`            | `id integer PRIMARY KEY CHECK(id=1)` | 单例管理员主键，CHECK(id=1)使本机只存在一个管理员账户。            |
| `password_hash` | `password_hash text NOT NULL`        | 盐与scrypt摘要的组合；用于验证密码，不存明文密码，也不是可逆加密。 |

### `sessions`

保存登录会话摘要及失效时间，不持久保存可直接使用的Cookie令牌。

| 字段         | 类型与数据库约束                  | 含义与设计目的                                                                |
| ------------ | --------------------------------- | ----------------------------------------------------------------------------- |
| `id_hash`    | `id_hash text PRIMARY KEY`        | 会话令牌SHA-256摘要；数据库泄露时不直接暴露可用Cookie，原令牌仅由客户端持有。 |
| `expires_at` | `expires_at timestamptz NOT NULL` | 登录会话过期时间；认证时拒绝到期令牌，限制一次登录的有效期。                  |

### `models`

维护可供不同任务选择的模型服务配置，密钥另存密钥库。

| 字段     | 类型与数据库约束        | 含义与设计目的                                                                                       |
| -------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `id`     | `id uuid PRIMARY KEY`   | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。                                                 |
| `config` | `config jsonb NOT NULL` | 模型标识、协议、端点、能力和价格JSON；有效API密钥由SecretStore另外存储，不能把apiKey持久写进此JSON。 |

### `chats`

管理群绑定、验收状态与处理游标，使不同群的调度和历史隔离。

| 字段                | 类型与数据库约束                                | 含义与设计目的                                                   |
| ------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| `id`                | `id uuid PRIMARY KEY`                           | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。             |
| `name`              | `name text NOT NULL`                            | 显示名称；便于管理员辨认，不能作为稳定身份或权限凭据。           |
| `binding_key`       | `binding_key text NOT NULL UNIQUE`              | 桥接绑定键且唯一；对应明确选中的群目标，避免按相似名称猜群。     |
| `enabled`           | `enabled boolean NOT NULL DEFAULT false`        | 是否被管理员启用；独立于资源是否存在和当前服务是否可用。         |
| `proactive`         | `proactive boolean NOT NULL DEFAULT true`       | 本群是否允许主动参与；仍受全局暂停、冷却和小时额度约束。         |
| `verified`          | `verified boolean NOT NULL DEFAULT false`       | 是否完成真实收发验收；配置了群名或桥接已连接不等于通过验收。     |
| `persona`           | `persona jsonb NOT NULL DEFAULT '{}'`           | 人设JSON；群表保存局部覆盖，空对象意味着沿用全局配置。           |
| `created_at`        | `created_at timestamptz NOT NULL DEFAULT now()` | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。 |
| `last_decision_at`  | `last_decision_at timestamptz`                  | 最近一次参与判断时间；限制高频调用判断模型，NULL表示尚未判断。   |
| `last_decision_seq` | `last_decision_seq bigint NOT NULL DEFAULT 0`   | 最近判断覆盖到的消息顺序号；避免对同一批历史反复判断。           |
| `memory_cursor`     | `memory_cursor bigint NOT NULL DEFAULT 0`       | 已推进到的记忆提取消息位置；区分已处理与新增聊天。               |
| `generation_epoch`  | `generation_epoch integer NOT NULL DEFAULT 0`   | 本群生成代次；暂停或设置改变后递增，发送前拒绝旧代次结果。       |
| `member_sequence`   | `member_sequence integer NOT NULL DEFAULT 0`    | 本群已分配成员编号计数器；事务内递增避免并发重号。               |
| `memory_reset_seq`  | `memory_reset_seq bigint NOT NULL DEFAULT 0`    | 记忆重置时的消息序号边界；旧消息不能重新进入当前记忆/上下文。    |
| `image_sequence`    | `image_sequence integer NOT NULL DEFAULT 0`     | 本群图片编号计数器；分配I开头展示编号时避免重复。                |

### `messages`

记录收发正文与身份来源，顺序号用于历史窗口和记忆批次。

| 字段                  | 类型与数据库约束                                           | 含义与设计目的                                                                               |
| --------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `id`                  | `id uuid PRIMARY KEY`                                      | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。                                         |
| `seq`                 | `seq bigserial UNIQUE`                                     | 全库bigserial顺序号；群内用它排序、分页和设置处理边界，不能当成群内连续计数。                |
| `event_id`            | `event_id text NOT NULL UNIQUE`                            | 桥接事件稳定ID且唯一；同一事件重传去重，相同文字不同事件应分别保留。                         |
| `chat_id`             | `chat_id uuid NOT NULL REFERENCES chats(id)`               | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。                                    |
| `content`             | `content text NOT NULL`                                    | 持久正文；供当前记录展示或检索，仍属于需按范围处理的不可信资料。                             |
| `direction`           | `direction text NOT NULL CHECK(direction IN ('in','out'))` | in/out区分收到与自身发出；防止把机器人回声再次触发普通回复。                                 |
| `sender_id`           | `sender_id text`                                           | 可空的外部发送者ID；桥接未可靠提供时保持NULL，不用昵称伪造。                                 |
| `sender_name`         | `sender_name text`                                         | 可空展示昵称；只用于表达和证据展示，不授予身份权限。                                         |
| `mentioned`           | `mentioned boolean NOT NULL DEFAULT false`                 | 事件中是否明确@机器人；用于回复优先级与命令路由。                                            |
| `observed_at`         | `observed_at timestamptz NOT NULL`                         | 桥接实际观察到事件的时间；用于过期判断及消息上下文时序。                                     |
| `created_at`          | `created_at timestamptz NOT NULL DEFAULT now()`            | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。                             |
| `state`               | `state text NOT NULL DEFAULT 'pending'`                    | 消息处理进度，初始pending；自发或图片可为observed，取消等后续状态由流水线维护。              |
| `raw`                 | `raw jsonb NOT NULL DEFAULT '{}'`                          | 事件来源、身份状态、成员候选、图片类型等JSON元数据；保留证据来源，不能把候选直接当verified。 |
| `memory_batch_id`     | `memory_batch_id uuid`                                     | 本条消息被哪个记忆批次领取；支撑失败恢复与批次隔离。                                         |
| `memory_processed_at` | `memory_processed_at timestamptz`                          | 完成记忆处理时间；NULL让未处理记录进入待处理索引。                                           |

### `outbox`

记录已提交但可能尚未投递到Redis的任务意图，弥合数据库与队列之间的提交空隙。

| 字段           | 类型与数据库约束                                | 含义与设计目的                                                                       |
| -------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `id`           | `id uuid PRIMARY KEY`                           | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。                                 |
| `unique_key`   | `unique_key text NOT NULL UNIQUE`               | 稳定业务意图键且唯一；同一任务重试登记不产生第二份意图。                             |
| `kind`         | `kind text NOT NULL`                            | 业务种类；驱动消费者或资源处理分派，不能与执行状态混用。                             |
| `chat_id`      | `chat_id uuid`                                  | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。                            |
| `payload`      | `payload jsonb NOT NULL`                        | 持久JSON载荷；恢复任务/事件所需，不得写入API密钥。                                   |
| `published_at` | `published_at timestamptz`                      | 首次发布登记时间；普通重投不刷新，显式重试可清空；NULL表示待发布，持久意图仍供恢复。 |
| `created_at`   | `created_at timestamptz NOT NULL DEFAULT now()` | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。                     |

### `tasks`

跟踪每个持久任务执行结果，支撑失败重试与人工排查。

| 字段         | 类型与数据库约束                                | 含义与设计目的                                                                                    |
| ------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `id`         | `id uuid PRIMARY KEY REFERENCES outbox(id)`     | 与outbox.id共用主键且外键关联；一个意图只有一份任务状态。                                         |
| `kind`       | `kind text NOT NULL`                            | 业务种类；驱动消费者或资源处理分派，不能与执行状态混用。                                          |
| `chat_id`    | `chat_id uuid`                                  | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。                                         |
| `state`      | `state text NOT NULL DEFAULT 'pending'`         | pending/running/retrying/failed/completed/cancelled等业务状态，SQL无枚举CHECK；不是发送账本状态。 |
| `attempts`   | `attempts integer NOT NULL DEFAULT 0`           | 已执行次数；限制/展示重试，不能直接解释为成功次数。                                               |
| `error`      | `error text`                                    | 任务失败的脱敏说明；用于重试或排查，不能保存密钥或完整请求。                                      |
| `result`     | `result jsonb`                                  | 任务执行结果JSON；供后续阶段/运行记录读取，不能仅凭存在就认定消息已发送。                         |
| `created_at` | `created_at timestamptz NOT NULL DEFAULT now()` | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。                                  |
| `updated_at` | `updated_at timestamptz NOT NULL DEFAULT now()` | 最近修改时间；用于界面排序及判断快照时效。                                                        |

### `sends`

维护发件账本与生成时的权限/配置快照，不确定发送不能当作未发送自动重试。

| 字段                | 类型与数据库约束                                 | 含义与设计目的                                                                                                                           |
| ------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                | `id uuid PRIMARY KEY`                            | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。                                                                                     |
| `chat_id`           | `chat_id uuid NOT NULL REFERENCES chats(id)`     | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。                                                                                |
| `source_message_id` | `source_message_id uuid`                         | 触发消息ID；用于追溯一次行为的输入，字段无FK时不会自动级联删除。                                                                         |
| `content`           | `content text NOT NULL`                          | 持久正文；供当前记录展示或检索，仍属于需按范围处理的不可信资料。                                                                         |
| `kind`              | `kind text NOT NULL`                             | 业务种类；驱动消费者或资源处理分派，不能与执行状态混用。                                                                                 |
| `status`            | `status text NOT NULL DEFAULT 'pending'`         | pending/sending/sent/unknown/cancelled等业务状态；not_sent是桥接返回结果，流水线可映射回pending重试而非正常持久状态；unknown须人工核查。 |
| `epoch`             | `epoch integer NOT NULL`                         | 创建发件时的群generation_epoch；发送前比对当前群代次防止过期结果发出。                                                                   |
| `detail`            | `detail text`                                    | 脱敏发送结果说明；保留不确定或拒绝原因供核查。                                                                                           |
| `created_at`        | `created_at timestamptz NOT NULL DEFAULT now()`  | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。                                                                         |
| `sent_at`           | `sent_at timestamptz`                            | 确认发送成功的时间；NULL不能被显示为已发。                                                                                               |
| `origin_at`         | `origin_at timestamptz`                          | 源触发事件的时间；与创建发件时间区分，避免队列延迟掩盖过期输入。                                                                         |
| `content_kind`      | `content_kind text NOT NULL DEFAULT 'text'`      | text等内容表示方式；发送器按它选择文本/媒体流程。                                                                                        |
| `asset_id`          | `asset_id uuid REFERENCES media_assets(id)`      | 可选素材ID并有FK；表情/图片发送引用media_assets。                                                                                        |
| `parent_id`         | `parent_id uuid`                                 | 关联主回复的发件ID；表情作为后续意图关联主回复，列本身没有FK。                                                                           |
| `actor_member_id`   | `actor_member_id uuid REFERENCES members(id)`    | 与当前回复有关的成员ID；发送前复查成员模式/身份。                                                                                        |
| `payload_expired`   | `payload_expired boolean NOT NULL DEFAULT false` | 正文载荷是否已按保留策略清理；true时账本可留审计但不能重试原内容。                                                                       |
| `reply_priority`    | `reply_priority integer NOT NULL DEFAULT 5`      | 队列优先级快照，默认5；影响调度先后，不授予成员权限。                                                                                    |
| `review_version`    | `review_version integer`                         | 生成时人工审核版本；可空表示不适用，发送前防止批准已撤销。                                                                               |
| `reply_mode`        | `reply_mode text NOT NULL DEFAULT 'normal'`      | 生成时的normal或特殊模式；供发送前复核当前模式。                                                                                         |
| `mode_version`      | `mode_version text`                              | 生成时模式配置版本指纹；配置变化后旧回复失效。                                                                                           |
| `attachment_id`     | `attachment_id uuid`                             | 关联原聊天图片ID；追猎/识图追溯来源，列未声明FK。                                                                                        |
| `hunt_version`      | `hunt_version integer`                           | 生成时追猎设置版本；设置改变后拒绝旧追猎回复。                                                                                           |

### `documents`

保存导入文档及联网资料的来源、正文和索引状态。

| 字段               | 类型与数据库约束                                      | 含义与设计目的                                                     |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `id`               | `id uuid PRIMARY KEY`                                 | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。               |
| `title`            | `title text NOT NULL`                                 | 文档展示标题；帮助用户辨认检索结果。                               |
| `source`           | `source text NOT NULL`                                | 来源标识；用于追溯资料或证据，不自动赋予可信身份。                 |
| `category`         | `category text NOT NULL DEFAULT '资料'`               | 业务分类；用于筛选与检索组织，不授予权限。                         |
| `tags`             | `tags jsonb NOT NULL DEFAULT '[]'`                    | JSON标签集合；支持多维筛选，不把标签当作模型系统指令。             |
| `content`          | `content text NOT NULL`                               | 持久正文；供当前记录展示或检索，仍属于需按范围处理的不可信资料。   |
| `status`           | `status text NOT NULL DEFAULT 'pending'`              | 文档索引处理状态，初始pending；并非来源事实可信等级。              |
| `created_at`       | `created_at timestamptz NOT NULL DEFAULT now()`       | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。   |
| `web_url`          | `web_url text`                                        | 规范化来源网址；非NULL时有唯一索引，使重复抓取更新同一文档。       |
| `web_content_hash` | `web_content_hash text`                               | 网页有效正文摘要；识别内容变更、避免无变化重复索引。               |
| `web_kind`         | `web_kind text CHECK(web_kind IN ('search','fetch'))` | search/fetch区分摘要收录与正文读取；使升级正文时不退回低质量摘要。 |
| `web_retrieved_at` | `web_retrieved_at timestamptz`                        | 本次网页资料取得时间；展示时效而不伪造网页发布日期。               |

### `chunks`

把文档拆为可单独检索和嵌入的切片，按文档与序号恢复原顺序。

| 字段                | 类型与数据库约束                                                       | 含义与设计目的                                                    |
| ------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `id`                | `id uuid PRIMARY KEY`                                                  | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。              |
| `document_id`       | `document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE` | 所属documents外键；文档删除时CASCADE清理切片，避免孤立检索结果。  |
| `content`           | `content text NOT NULL`                                                | 持久正文；供当前记录展示或检索，仍属于需按范围处理的不可信资料。  |
| `search_text`       | `search_text tsvector NOT NULL`                                        | 为全文检索生成的tsvector；不是原文，GIN索引用于加速词项查询。     |
| `embedding`         | `embedding vector`                                                     | 可选向量；未生成/失效时为NULL，不能与其他模型代次向量混算。       |
| `embedding_version` | `embedding_version integer`                                            | 生成向量时的嵌入配置代次；用于换模型后识别待重建索引。            |
| `ordinal`           | `ordinal integer NOT NULL`                                             | 在原文的切片序号；与document_id联合唯一，定位片段及恢复相邻顺序。 |

### `memories`

保存可编辑的长期记忆及其可见范围，与原始聊天正文分开保留。

| 字段                 | 类型与数据库约束                                                                      | 含义与设计目的                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`                 | `id uuid PRIMARY KEY`                                                                 | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。                                                        |
| `content`            | `content text NOT NULL`                                                               | 持久正文；供当前记录展示或检索，仍属于需按范围处理的不可信资料。                                            |
| `category`           | `category text NOT NULL`                                                              | 业务分类；用于筛选与检索组织，不授予权限。                                                                  |
| `tags`               | `tags jsonb NOT NULL DEFAULT '[]'`                                                    | JSON标签集合；支持多维筛选，不把标签当作模型系统指令。                                                      |
| `confidence`         | `confidence double precision NOT NULL`                                                | 提取置信评分；帮助筛选候选，不是经校准的事实正确概率。                                                      |
| `status`             | `status text NOT NULL CHECK(status IN ('active','candidate','conflicted','deleted'))` | active/candidate/conflicted/deleted由CHECK约束；只有active进入普通记忆检索。                                |
| `pinned`             | `pinned boolean NOT NULL DEFAULT false`                                               | 是否固定；防止自动整理覆盖或提升展示优先级，不免除显式删除规则。                                            |
| `version`            | `version integer NOT NULL DEFAULT 1`                                                  | 记录或配置的递增版本；使旧索引、快照或任务结果可以被识别为过期。                                            |
| `source_chat_id`     | `source_chat_id uuid REFERENCES chats(id)`                                            | 来源群外键；表达最初从何得到，与当前可见范围scope_chat_id不是同一含义。                                     |
| `source_message_ids` | `source_message_ids jsonb NOT NULL DEFAULT '[]'`                                      | 来源消息ID的JSON数组；用于溯源，即使正文到期也能保留来源标识。                                              |
| `source_batch`       | `source_batch text`                                                                   | 提取批次标识；与内容MD5形成部分唯一索引，使同批同内容去重。                                                 |
| `subject_key`        | `subject_key text`                                                                    | 记忆主题键，如member-impression；供整合相同主题，不是用户身份凭据。                                         |
| `supersedes`         | `supersedes uuid REFERENCES memories(id)`                                             | 被此条替代的旧记忆外键；记录演进关系而非直接覆盖来源。                                                      |
| `search_text`        | `search_text tsvector NOT NULL`                                                       | 为全文检索生成的tsvector；不是原文，GIN索引用于加速词项查询。                                               |
| `embedding`          | `embedding vector`                                                                    | 可选向量；未生成/失效时为NULL，不能与其他模型代次向量混算。                                                 |
| `embedding_version`  | `embedding_version integer`                                                           | 生成向量时的嵌入配置代次；用于换模型后识别待重建索引。                                                      |
| `created_at`         | `created_at timestamptz NOT NULL DEFAULT now()`                                       | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。                                            |
| `updated_at`         | `updated_at timestamptz NOT NULL DEFAULT now()`                                       | 最近修改时间；用于界面排序及判断快照时效。                                                                  |
| `visibility`         | `visibility text NOT NULL DEFAULT 'global'`                                           | global/chat/member/unassigned；global无群成员归属，chat须群且无成员，member两者必填，unassigned不参与检索。 |
| `scope_chat_id`      | `scope_chat_id uuid REFERENCES chats(id)`                                             | 当前可见范围对应群；与member_id复合FK确保成员确属该群。                                                     |
| `member_id`          | `member_id uuid`                                                                      | 成员私域归属；仅visibility=member时必填，非成员范围必须NULL。                                               |

### `memory_versions`

保留修改/删除前的记忆版本，支持审计；不是当前检索源。

| 字段         | 类型与数据库约束                                | 含义与设计目的                                                   |
| ------------ | ----------------------------------------------- | ---------------------------------------------------------------- |
| `id`         | `id bigserial PRIMARY KEY`                      | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。             |
| `memory_id`  | `memory_id uuid NOT NULL`                       | 原记忆ID，刻意未声明FK；历史不因主记录清理而被级联删除。         |
| `version`    | `version integer NOT NULL`                      | 记录或配置的递增版本；使旧索引、快照或任务结果可以被识别为过期。 |
| `snapshot`   | `snapshot jsonb NOT NULL`                       | 变更前或确认时的JSON快照；便于审计，不随当前记录继续变动。       |
| `created_at` | `created_at timestamptz NOT NULL DEFAULT now()` | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。 |

### `persona_versions`

保存人设变化历史，使全局及群覆盖修改可回溯。

| 字段         | 类型与数据库约束                                | 含义与设计目的                                                         |
| ------------ | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `id`         | `id bigserial PRIMARY KEY`                      | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。                   |
| `chat_id`    | `chat_id uuid`                                  | NULL表示全局人设版本；有群ID表示群覆盖版本，未设置FK便于保留独立历史。 |
| `persona`    | `persona jsonb NOT NULL`                        | 人设JSON；群表保存局部覆盖，空对象意味着沿用全局配置。                 |
| `created_at` | `created_at timestamptz NOT NULL DEFAULT now()` | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。       |

### `runtime_logs`

保留脱敏运行事件，供定位任务和群级故障。

| 字段         | 类型与数据库约束                                | 含义与设计目的                                                   |
| ------------ | ----------------------------------------------- | ---------------------------------------------------------------- |
| `id`         | `id bigserial PRIMARY KEY`                      | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。             |
| `level`      | `level text NOT NULL`                           | 日志级别；用于过滤告警和错误。                                   |
| `message`    | `message text NOT NULL`                         | 简短脱敏事件说明；写入方法限制长度，但不会自动去掉敏感内容。     |
| `chat_id`    | `chat_id uuid`                                  | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。        |
| `metadata`   | `metadata jsonb NOT NULL DEFAULT '{}'`          | 结构化日志上下文；便于追踪，写入方负责脱敏，字段本身不会加密。   |
| `created_at` | `created_at timestamptz NOT NULL DEFAULT now()` | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。 |

### `members`

按群分配成员编号与身份档案，不跨群按昵称合并。

| 字段              | 类型与数据库约束                                                                                                | 含义与设计目的                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `id`              | `id uuid PRIMARY KEY`                                                                                           | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。               |
| `chat_id`         | `chat_id uuid NOT NULL REFERENCES chats(id)`                                                                    | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。          |
| `number`          | `number integer NOT NULL`                                                                                       | 群内普通成员展示编号；与chat_id联合唯一，与数据库UUID分离。        |
| `sender_key`      | `sender_key text NOT NULL`                                                                                      | 群内稳定成员键；与chat_id联合唯一，不能仅按昵称认人。              |
| `nickname`        | `nickname text NOT NULL DEFAULT ''`                                                                             | 当前群昵称；可变且可能同名，不作为唯一身份。                       |
| `aliases`         | `aliases jsonb NOT NULL DEFAULT '[]'`                                                                           | 历史称呼JSON数组；支持检索旧名字，不把同名直接合并。               |
| `identity_status` | `identity_status text NOT NULL DEFAULT 'unknown' CHECK(identity_status IN ('verified','unknown','conflicted'))` | verified/unknown/conflicted；冲突或未知不能作为个人记忆/权限证明。 |
| `profile`         | `profile jsonb NOT NULL DEFAULT '{}'`                                                                           | 成员画像JSON；用于个性化上下文，不等于权限配置。                   |
| `pinned`          | `pinned boolean NOT NULL DEFAULT false`                                                                         | 是否固定；防止自动整理覆盖或提升展示优先级，不免除显式删除规则。   |
| `manual_profile`  | `manual_profile boolean NOT NULL DEFAULT false`                                                                 | 是否标记为人工画像；允许业务逻辑区别管理员编辑与自动整理。         |
| `version`         | `version integer NOT NULL DEFAULT 1`                                                                            | 记录或配置的递增版本；使旧索引、快照或任务结果可以被识别为过期。   |
| `created_at`      | `created_at timestamptz NOT NULL DEFAULT now()`                                                                 | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。   |
| `updated_at`      | `updated_at timestamptz NOT NULL DEFAULT now()`                                                                 | 最近修改时间；用于界面排序及判断快照时效。                         |

### `member_profile_versions`

保存成员档案旧版本与身份确认快照，保留变更依据。

| 字段         | 类型与数据库约束                                 | 含义与设计目的                                                   |
| ------------ | ------------------------------------------------ | ---------------------------------------------------------------- |
| `id`         | `id bigserial PRIMARY KEY`                       | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。             |
| `member_id`  | `member_id uuid NOT NULL REFERENCES members(id)` | 关联成员ID；涉及身份时必须与同一行的群ID共同校验。               |
| `version`    | `version integer NOT NULL`                       | 记录或配置的递增版本；使旧索引、快照或任务结果可以被识别为过期。 |
| `snapshot`   | `snapshot jsonb NOT NULL`                        | 变更前或确认时的JSON快照；便于审计，不随当前记录继续变动。       |
| `created_at` | `created_at timestamptz NOT NULL DEFAULT now()`  | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。 |

### `identity_bindings`

记录原生群身份绑定及批准证据，声明来源不等于当前桌面桥接自动具备该能力。

| 字段             | 类型与数据库约束                                       | 含义与设计目的                                                                           |
| ---------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `chat_id`        | `chat_id uuid PRIMARY KEY REFERENCES chats(id)`        | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。                                |
| `account_id`     | `account_id text NOT NULL`                             | 微信账户标识；与native_chat_id联合唯一防止相同原生群错误绑定。                           |
| `native_chat_id` | `native_chat_id text NOT NULL`                         | 原生群标识；与界面群名分开，不能由猜测昵称填充。                                         |
| `source`         | `source text NOT NULL CHECK(source='wechat-database')` | CHECK只允许wechat-database，记录此绑定来源；不是当前免费UI桥接提供原生数据库身份的保证。 |
| `approved`       | `approved boolean NOT NULL DEFAULT false`              | 管理员是否批准此绑定；证据存在不自动批准。                                               |
| `verified_at`    | `verified_at timestamptz`                              | 绑定核验时间；NULL表示尚未记录核验。                                                     |
| `evidence`       | `evidence jsonb NOT NULL DEFAULT '{}'`                 | JSON证据快照；用于解释审核或身份判定，不是通用权限令牌。                                 |

### `plan_members`

为每群的两个计划席位关联成员，限制席位和成员重复授权。

| 字段        | 类型与数据库约束                             | 含义与设计目的                                            |
| ----------- | -------------------------------------------- | --------------------------------------------------------- |
| `chat_id`   | `chat_id uuid NOT NULL REFERENCES chats(id)` | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。 |
| `slot`      | `slot integer NOT NULL CHECK(slot IN (1,2))` | 计划席位编号且仅1或2；复合主键限制每群两个席位。          |
| `member_id` | `member_id uuid NOT NULL`                    | 关联成员ID；涉及身份时必须与同一行的群ID共同校验。        |

### `member_modes`

记录成员在本群当前选择的特殊模式。

| 字段         | 类型与数据库约束                                      | 含义与设计目的                                                          |
| ------------ | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `chat_id`    | `chat_id uuid NOT NULL`                               | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。               |
| `member_id`  | `member_id uuid NOT NULL`                             | 关联成员ID；涉及身份时必须与同一行的群ID共同校验。                      |
| `mode`       | `mode text NOT NULL CHECK(mode IN ('jerops','plan'))` | jerops/plan特殊模式枚举；按群与成员联合主键记录，不能从其他群借用模式。 |
| `updated_at` | `updated_at timestamptz NOT NULL DEFAULT now()`       | 最近修改时间；用于界面排序及判断快照时效。                              |

### `mode_settings`

按作用域保存特殊模式的配置。

| 字段    | 类型与数据库约束                    | 含义与设计目的                                                     |
| ------- | ----------------------------------- | ------------------------------------------------------------------ |
| `scope` | `scope text PRIMARY KEY`            | 命名作用域键；区分全局、群或成员命名空间，不能解释为数据库schema。 |
| `value` | `value jsonb NOT NULL DEFAULT '{}'` | 该命名键的JSON配置；字段结构由对应业务服务校验与升级。             |

### `foods`

保存可抽取菜品与可选图片，和群启用关系分开管理。

| 字段             | 类型与数据库约束                                  | 含义与设计目的                                                   |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| `id`             | `id uuid PRIMARY KEY`                             | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。             |
| `name`           | `name text NOT NULL`                              | 显示名称；便于管理员辨认，不能作为稳定身份或权限凭据。           |
| `description`    | `description text NOT NULL DEFAULT ''`            | 菜品介绍；供选择和展示，不是执行指令。                           |
| `category`       | `category text NOT NULL DEFAULT '菜品'`           | 业务分类；用于筛选与检索组织，不授予权限。                       |
| `tags`           | `tags jsonb NOT NULL DEFAULT '[]'`                | JSON标签集合；支持多维筛选，不把标签当作模型系统指令。           |
| `enabled`        | `enabled boolean NOT NULL DEFAULT true`           | 是否被管理员启用；独立于资源是否存在和当前服务是否可用。         |
| `created_at`     | `created_at timestamptz NOT NULL DEFAULT now()`   | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。 |
| `updated_at`     | `updated_at timestamptz NOT NULL DEFAULT now()`   | 最近修改时间；用于界面排序及判断快照时效。                       |
| `image_asset_id` | `image_asset_id uuid REFERENCES media_assets(id)` | 可空素材外键；菜品与图片分别维护，不嵌入二进制。                 |

### `chat_foods`

定义每群实际参与抽签的菜品集合。

| 字段      | 类型与数据库约束                             | 含义与设计目的                                              |
| --------- | -------------------------------------------- | ----------------------------------------------------------- |
| `chat_id` | `chat_id uuid NOT NULL REFERENCES chats(id)` | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。   |
| `food_id` | `food_id uuid NOT NULL REFERENCES foods(id)` | 参与该群抽签的菜品外键；与chat_id复合主键防止同群重复启用。 |

### `food_draws`

固化每次抽签的候选与结果，避免重试产生不同菜品。

| 字段                | 类型与数据库约束                                | 含义与设计目的                                                   |
| ------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| `id`                | `id uuid PRIMARY KEY`                           | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。             |
| `chat_id`           | `chat_id uuid NOT NULL REFERENCES chats(id)`    | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。        |
| `source_message_id` | `source_message_id uuid NOT NULL UNIQUE`        | 触发抽签的消息ID且唯一；同一输入重试不能重新随机。               |
| `food_id`           | `food_id uuid NOT NULL REFERENCES foods(id)`    | 抽中的菜品外键；保留对当前菜品的引用。                           |
| `food_name`         | `food_name text NOT NULL`                       | 抽签时的名称快照；菜品改名后旧结果仍能解释。                     |
| `candidates`        | `candidates jsonb NOT NULL`                     | 抽签时的候选列表JSON；保留随机选择的实际范围。                   |
| `created_at`        | `created_at timestamptz NOT NULL DEFAULT now()` | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。 |

### `media_assets`

登记图片、GIF及原生表情的本地资源与分类状态。

| 字段          | 类型与数据库约束                                                         | 含义与设计目的                                                    |
| ------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `id`          | `id uuid PRIMARY KEY`                                                    | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。              |
| `name`        | `name text NOT NULL`                                                     | 显示名称；便于管理员辨认，不能作为稳定身份或权限凭据。            |
| `kind`        | `kind text NOT NULL CHECK(kind IN ('image','gif','native-sticker'))`     | image/gif/native-sticker由CHECK限定；区分本地字节与原生表情引用。 |
| `mime_type`   | `mime_type text`                                                         | 经过解码核验的媒体类型；决定后续处理，不能只相信文件扩展名。      |
| `file_path`   | `file_path text`                                                         | 本地资源路径；数据库只保存位置，备份数据库不等于备份文件。        |
| `sha256`      | `sha256 text`                                                            | 文件字节摘要；用于校验/去重，不证明图片发件人身份。               |
| `native_ref`  | `native_ref jsonb`                                                       | 可空原生表情引用JSON；无可导出文件时保留桥接识别信息。            |
| `tags`        | `tags jsonb NOT NULL DEFAULT '{"emotion":[],"scene":[],"intensity":[]}'` | emotion/scene/intensity等JSON分类；支持按语气与场景选择素材。     |
| `manual_tags` | `manual_tags boolean NOT NULL DEFAULT false`                             | 标签是否由人工维护；自动分类不能无条件覆盖人工决定。              |
| `enabled`     | `enabled boolean NOT NULL DEFAULT true`                                  | 是否被管理员启用；独立于资源是否存在和当前服务是否可用。          |
| `status`      | `status text NOT NULL DEFAULT 'ready'`                                   | 资源处理状态，初始ready；禁用与删除应按业务规则区别。             |
| `created_at`  | `created_at timestamptz NOT NULL DEFAULT now()`                          | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。  |
| `updated_at`  | `updated_at timestamptz NOT NULL DEFAULT now()`                          | 最近修改时间；用于界面排序及判断快照时效。                        |

### `data_versions`

为缓存命名空间提供递增失效版本，避免长期复用过期查询结果。

| 字段      | 类型与数据库约束                    | 含义与设计目的                                                     |
| --------- | ----------------------------------- | ------------------------------------------------------------------ |
| `scope`   | `scope text PRIMARY KEY`            | 命名作用域键；区分全局、群或成员命名空间，不能解释为数据库schema。 |
| `version` | `version bigint NOT NULL DEFAULT 0` | 记录或配置的递增版本；使旧索引、快照或任务结果可以被识别为过期。   |

### `memory_selections`

冻结批量删除的选择快照，避免确认后按变化的筛选条件误删新记录。

| 字段            | 类型与数据库约束                                | 含义与设计目的                                                         |
| --------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `token`         | `token text PRIMARY KEY`                        | 冻结选择的随机凭据；后续删除凭它读取既定ID集合，不能重新运行实时筛选。 |
| `snapshot`      | `snapshot jsonb NOT NULL`                       | 固定选择的ID/版本等JSON；使确认数量与实际删除目标一致。                |
| `expires_at`    | `expires_at timestamptz NOT NULL`               | 冻结选择的失效时间；限制删除令牌可被继续使用的期限。                       |
| `deleted_count` | `deleted_count integer`                         | 执行后的删除数量；NULL表示尚未记录执行结果，便于幂等反馈。             |
| `created_at`    | `created_at timestamptz NOT NULL DEFAULT now()` | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。       |

### `model_calls`

记录每次模型调用及重试/轮次用量，支持真实费用统计。

| 字段          | 类型与数据库约束                   | 含义与设计目的                                                          |
| ------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| `id`          | `id uuid PRIMARY KEY`              | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。                    |
| `run_id`      | `run_id uuid NOT NULL`             | 一次逻辑模型运行的聚合ID；多轮工具调用和重试可归入同次运行。            |
| `model_id`    | `model_id text NOT NULL`           | 调用时的模型配置标识文本；不加FK避免删除配置后历史统计丢失。            |
| `model_name`  | `model_name text NOT NULL`         | 调用时模型名称快照；后来改名不改变历史报表。                            |
| `protocol`    | `protocol text NOT NULL`           | 模型服务线协议；决定请求/响应适配方式，不是模型名称。                   |
| `purpose`     | `purpose text NOT NULL`            | chat/preview/decision等调用用途；将用户预览与正式聊天的成本分开。       |
| `task_id`     | `task_id text`                     | 可空任务标识文本；预览等非持久任务可没有该值。                          |
| `chat_id`     | `chat_id text`                     | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。               |
| `member_id`   | `member_id text`                   | 关联成员ID；涉及身份时必须与同一行的群ID共同校验。                      |
| `attempt`     | `attempt integer NOT NULL`         | 本次运行重试次数标记；用于解释失败与重复计费。                          |
| `round`       | `round integer NOT NULL`           | 工具循环中的轮次；同一run可有多次厂商请求。                             |
| `status`      | `status text NOT NULL`             | 处理/审核状态；具体合法值若有SQL CHECK见定义，无CHECK时由业务服务维护。 |
| `started_at`  | `started_at timestamptz NOT NULL`  | 本次厂商调用开始时间；按它选择统计时间范围。                            |
| `finished_at` | `finished_at timestamptz NOT NULL` | 本次厂商调用结束时间；与开始时间计算耗时。                              |
| `usage`       | `usage jsonb NOT NULL`             | 厂商实际返回的输入/输出/缓存用量JSON；未知量保持未知。                  |
| `cost`        | `cost numeric`                     | 按价格快照计算的费用；NULL表示缺价格或用量，不能显示为免费。            |
| `currency`    | `currency text`                    | 费用计价币种；不能直接跨币种相加。                                      |
| `pricing`     | `pricing jsonb`                    | 调用时的单价快照；后续改价不自动重算历史。                              |
| `http_status` | `http_status integer`              | 可空HTTP响应状态；网络未得到响应时不能伪造200。                         |

### `chat_sticker_settings`

按群显式控制自动表情功能。

| 字段      | 类型与数据库约束                                                  | 含义与设计目的                                            |
| --------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| `chat_id` | `chat_id uuid PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE` | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。 |
| `enabled` | `enabled boolean NOT NULL DEFAULT false`                          | 是否被管理员启用；独立于资源是否存在和当前服务是否可用。  |

### `memory_control`

全局单例记忆代次与重置时间，阻止旧任务重新写回已重置记忆。

| 字段              | 类型与数据库约束                                | 含义与设计目的                                                       |
| ----------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| `id`              | `id integer PRIMARY KEY CHECK(id=1)`            | 全局单例控制行，CHECK(id=1)；让重置和消息接收可以锁同一行协调。      |
| `epoch`           | `epoch integer NOT NULL DEFAULT 0`              | 全局记忆代次；重置递增后旧提取/整合任务不能写回。                    |
| `reset_at`        | `reset_at timestamptz NOT NULL DEFAULT 'epoch'` | 最近一次重置时间；拒绝迟到的旧事件，初始Postgres epoch表示尚未重置。 |
| `last_cleanup_at` | `last_cleanup_at timestamptz`                   | 最近保留期清理时间；支持启动补跑和定时维护。                         |

### `message_receipts`

正文清理后仍保留事件去重凭据，避免重连重传重新入库。

| 字段         | 类型与数据库约束                                | 含义与设计目的                                                       |
| ------------ | ----------------------------------------------- | -------------------------------------------------------------------- |
| `event_id`   | `event_id text PRIMARY KEY`                     | 即使messages正文到期清理仍保留的稳定事件ID；防止同事件再次创建正文。 |
| `chat_id`    | `chat_id uuid NOT NULL`                         | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。            |
| `created_at` | `created_at timestamptz NOT NULL DEFAULT now()` | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。     |

### `member_ui_evidence`

把UI身份证据与画像正文分离，独立失效冲突证据。

| 字段                    | 类型与数据库约束                                    | 含义与设计目的                                                |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| `member_id`             | `member_id uuid PRIMARY KEY REFERENCES members(id)` | 关联成员ID；涉及身份时必须与同一行的群ID共同校验。            |
| `chat_id`               | `chat_id uuid NOT NULL`                             | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。     |
| `name`                  | `name text NOT NULL`                                | 本次核验的群昵称；只是证据的一部分，不能只凭此值授权。        |
| `appearance_hash`       | `appearance_hash text`                              | 可空头像外观精确摘要；防止同名成员共用证据。                  |
| `source_event_id`       | `source_event_id text`                              | 提供证据的入站事件标识；建立当前消息与资料卡的关联。          |
| `confirmation`          | `confirmation jsonb NOT NULL DEFAULT '{}'`          | 确认任务及证据快照JSON；支持复查，不把候选等同当前有效身份。  |
| `evidence_version`      | `evidence_version integer NOT NULL DEFAULT 0`       | 身份外观证据代次；同名/外观冲突时递增，使旧消息上的证据失效。 |
| `appearance_descriptor` | `appearance_descriptor jsonb`                       | 可空头像描述JSON；补充渲染容错比较，与精确hash分开保留。      |

### `member_reviews`

维护人工审核当前状态与版本，发送前可复查批准是否仍有效。

| 字段               | 类型与数据库约束                                                              | 含义与设计目的                                                            |
| ------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `chat_id`          | `chat_id uuid NOT NULL`                                                       | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。                 |
| `member_id`        | `member_id uuid NOT NULL`                                                     | 关联成员ID；涉及身份时必须与同一行的群ID共同校验。                        |
| `status`           | `status text NOT NULL CHECK(status IN ('approved','revoked','needs-review'))` | approved/revoked/needs-review；审核行不是昵称白名单，发送时还须核对版本。 |
| `approval_version` | `approval_version integer NOT NULL DEFAULT 1`                                 | 审核代次；撤销或重审后使旧批准与排队结果失效。                            |
| `reviewed_at`      | `reviewed_at timestamptz NOT NULL DEFAULT now()`                              | 最近审核操作时间；用于解释当前批准或撤销的时效。                          |
| `evidence`         | `evidence jsonb NOT NULL DEFAULT '{}'`                                        | JSON证据快照；用于解释审核或身份判定，不是通用权限令牌。                  |

### `member_review_audit`

保留审核变化流水，撤销当前权限不抹掉过去操作依据。

| 字段               | 类型与数据库约束                                | 含义与设计目的                                                   |
| ------------------ | ----------------------------------------------- | ---------------------------------------------------------------- |
| `id`               | `id bigserial PRIMARY KEY`                      | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。             |
| `chat_id`          | `chat_id uuid NOT NULL`                         | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。        |
| `member_id`        | `member_id uuid NOT NULL`                       | 关联成员ID；涉及身份时必须与同一行的群ID共同校验。               |
| `status`           | `status text NOT NULL`                          | 此次审核动作的状态快照；无枚举CHECK，由审核服务写入并保留历史。  |
| `approval_version` | `approval_version integer NOT NULL`             | 审核代次；撤销或重审后使旧批准与排队结果失效。                   |
| `evidence`         | `evidence jsonb NOT NULL`                       | JSON证据快照；用于解释审核或身份判定，不是通用权限令牌。         |
| `created_at`       | `created_at timestamptz NOT NULL DEFAULT now()` | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。 |

### `chat_images`

登记消息中的每次图片出现及处理进度，图片字节与事件身份不混同。

| 字段                  | 类型与数据库约束                                                                    | 含义与设计目的                                                               |
| --------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `id`                  | `id uuid PRIMARY KEY`                                                               | 稳定记录主键；用于跨表关联，不能以可变显示名称代替。                         |
| `chat_id`             | `chat_id uuid NOT NULL REFERENCES chats(id)`                                        | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。                    |
| `message_id`          | `message_id uuid NOT NULL UNIQUE`                                                   | 对应messages.id且唯一；列未声明FK，以业务生命周期协调清理。                  |
| `event_id`            | `event_id text NOT NULL UNIQUE`                                                     | 图片发生事件的稳定ID且唯一；不能用文件摘要替代，否则同图多次发送会被误去重。 |
| `number`              | `number integer NOT NULL`                                                           | 群内显示编号；与chat_id联合唯一，便于用户引用而不暴露UUID。                  |
| `owner_member_id`     | `owner_member_id uuid`                                                              | 可空图片成员归属；复合FK保证归属不跨群，未知保持NULL。                       |
| `status`              | `status text NOT NULL CHECK(status IN ('pending','ready','unavailable','expired'))` | pending/ready/unavailable/expired；就绪才可读取，过期/不可用不伪造识别结果。 |
| `quality`             | `quality text NOT NULL DEFAULT 'thumbnail'`                                         | thumbnail等取得质量；标明UI截图不等于原始高清图片。                          |
| `mime_type`           | `mime_type text`                                                                    | 经过解码核验的媒体类型；决定后续处理，不能只相信文件扩展名。                 |
| `width`               | `width integer`                                                                     | 真实解码宽度像素；结合高度限制资源消耗。                                     |
| `height`              | `height integer`                                                                    | 真实解码高度像素；不能只相信上传方声明。                                     |
| `sha256`              | `sha256 text`                                                                       | 文件字节摘要；用于校验/去重，不证明图片发件人身份。                          |
| `file_path`           | `file_path text`                                                                    | 本地资源路径；数据库只保存位置，备份数据库不等于备份文件。                   |
| `observed_at`         | `observed_at timestamptz NOT NULL`                                                  | 桥接实际观察到事件的时间；用于过期判断及消息上下文时序。                     |
| `created_at`          | `created_at timestamptz NOT NULL DEFAULT now()`                                     | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。             |
| `reason`              | `reason text`                                                                       | 不可用/过期原因；供运行记录解释，不保存敏感原始异常。                        |
| `hunt_result`         | `hunt_result jsonb`                                                                 | 追猎相似度等结果JSON；分数不是概率，不能凭检测结果授予身份。                 |
| `hunt_checked_at`     | `hunt_checked_at timestamptz`                                                       | 完成检测的时间；用于区别待检与已有结果。                                     |
| `generation_epoch`    | `generation_epoch integer NOT NULL DEFAULT -1`                                      | 登记事件时的群代次，历史迁移默认-1；停止后旧图不能被赋予当前代次重新触发。   |
| `hunt_progress`       | `hunt_progress jsonb NOT NULL DEFAULT '{}'`                                         | 检测/生成等阶段进度JSON；让队列展示真实阶段而不只显示笼统运行中。            |
| `hunt_detect_task_id` | `hunt_detect_task_id uuid`                                                          | 关联持久检测任务ID；便于按阶段追踪/取消。                                    |
| `hunt_reply_task_id`  | `hunt_reply_task_id uuid`                                                           | 关联持久回复生成任务ID；与检测任务分离便于调度和重试。                       |

### `hunt_cooldowns`

为每群每成员记录最近一次追猎占用，控制并发与冷却。

| 字段              | 类型与数据库约束                                     | 含义与设计目的                                                 |
| ----------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| `chat_id`         | `chat_id uuid NOT NULL REFERENCES chats(id)`         | 归属群ID；查询/修改时按它限定群边界，避免跨群读取或授权。      |
| `member_id`       | `member_id uuid NOT NULL`                            | 关联成员ID；涉及身份时必须与同一行的群ID共同校验。             |
| `task_id`         | `task_id uuid NOT NULL`                              | 当前占用该冷却槽的任务ID；并发任务不能重复占用同一群成员窗口。 |
| `last_trigger_at` | `last_trigger_at timestamptz NOT NULL DEFAULT now()` | 最近触发占用时间；计算冷却剩余时间而非用任务完成时间。         |

### `hunt_references`

登记内置及上传参考图，内容摘要用于去重，软删除保留历史版本可解释性。

| 字段         | 类型与数据库约束                                             | 含义与设计目的                                                     |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `id`         | `id text PRIMARY KEY`                                        | 文本参考图ID；兼容固定内置ID及上传生成ID，不能强转UUID。           |
| `name`       | `name text NOT NULL`                                         | 显示名称；便于管理员辨认，不能作为稳定身份或权限凭据。             |
| `source`     | `source text NOT NULL CHECK(source IN ('builtin','upload'))` | builtin/upload由CHECK限定；决定是否允许删除和如何展示来源。        |
| `category`   | `category text NOT NULL`                                     | 业务分类；用于筛选与检索组织，不授予权限。                         |
| `path`       | `path text NOT NULL`                                         | 本地图像源文件位置；数据库不是图片二进制备份。                     |
| `crop`       | `crop jsonb`                                                 | 可空裁剪坐标JSON；只比较指定区域，NULL表示使用全图。               |
| `digest`     | `digest text NOT NULL`                                       | 源图字节摘要；上传资源部分唯一索引用于去重，不能用于判断消息重复。 |
| `thumbnail`  | `thumbnail text NOT NULL`                                    | 缩略图本地路径；管理端预览与原文件分离。                           |
| `deleted_at` | `deleted_at timestamptz`                                     | 软删除时间；NULL表示当前可选，历史图库仍可能引用文件。             |
| `created_at` | `created_at timestamptz NOT NULL DEFAULT now()`              | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。   |

### `hunt_galleries`

保存不可变图库版本及其文件清单，任务固定引用生成时所用图库。

| 字段            | 类型与数据库约束                                | 含义与设计目的                                                      |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| `version`       | `version text PRIMARY KEY`                      | 不可变图库版本ID（text）；用于任务固定参考集合，不是递增SQL迁移号。 |
| `manifest`      | `manifest text NOT NULL`                        | 该版本参考图清单文件路径；历史版本不能随当前选择原地覆盖。          |
| `reference_ids` | `reference_ids jsonb NOT NULL`                  | 该版本启用参考ID的JSON数组；空数组支持初装无素材且追猎关闭。        |
| `created_at`    | `created_at timestamptz NOT NULL DEFAULT now()` | 记录创建时间；用于排序、保留期或审计，不替代事件的实际观察时间。    |

### `schema_migrations`

记录已应用SQL文件，启动按文件名跳过；没有内容checksum。

| 字段         | 类型与数据库约束                       | 含义与设计目的                                                  |
| ------------ | -------------------------------------- | --------------------------------------------------------------- |
| `name`       | `name text PRIMARY KEY`                | 已完成迁移的文件名主键；只防止同名重跑，不验证文件内容。        |
| `applied_at` | `applied_at timestamptz DEFAULT now()` | 迁移登记时间；默认now()，定义未加NOT NULL，历史维护可出现NULL。 |

## 跨列约束与索引为什么存在

- 成员 `UNIQUE(chat_id,number)` / `UNIQUE(chat_id,sender_key)` 保障群内编号和身份键唯一；`UNIQUE(chat_id,id)` 为复合外键提供目标。plan_members、member_modes、member_ui_evidence、member_reviews、成员记忆和图片归属通过群+成员复合外键防止跨群关联。
- plan_members 主键为群+slot（slot仅1/2），另有群+member唯一；同一成员不能同时占两个席位。member_modes 主键为群+成员。identity_bindings 对account_id+native_chat_id唯一。
- chunks 的文档+ordinal唯一；messages(event_id)、chat_images(event_id/message_id)唯一保障事件幂等；同文/同图不同事件不得按内容去重。
- message/chat时间索引用于历史、保留期与运行列表。messages_memory_unprocessed 是入站且未处理记忆的部分索引；messages_member_evidence_idx 仅索引 verified 入站消息的成员证据，不包含未知身份。
- memories.search_text 与 chunks.search_text 建GIN索引；memories_scope_idx 仅覆盖active记忆，listing索引排除deleted并按固定/更新时间排序。
- memories(source_batch,md5(content)) 仅在批次非NULL时唯一，用于同批提取去重，不是跨批全局内容去重。MD5此处仅作去重，不作密码/签名。
- memory_selections按expires_at索引便于过期清理。data_versions按scope主键UPSERT递增，使检索缓存失效。
- model_calls按调用时间及群/模型/时间索引，支持时间段统计。费用NULL与0区别必须保留。
- sends_one_sticker_per_reply 最终规则来自008：仅kind=sticker且status非cancelled时，parent_id唯一。取消旧发送后可以人工重新建立意图，不能把已不确定的旧发送直接自动重发。
- chat_foods主键为群+菜品；food_draws.source_message_id唯一，防止重试改变抽签结果。media_assets(kind,sha256)唯一，但sha256为NULL时Postgres允许多行，不能当成可靠原生表情去重。
- documents.web_url仅非NULL时唯一。hunt_reference_upload_digest仅source=upload时唯一；软删除行仍占用摘要，上传相同资源走恢复/重复处理，不新造另一条同摘要上传。
- hunt_cooldowns按群+成员主键；图库版本记录无外键指向清单中的图片ID，文件与历史资源须由业务层保留，不能只删除当前目录。
- memories.visibility/scope/member组合由004中的memory_scope CHECK限制：global两归属均NULL；chat须群且成员NULL；member两者必填；unassigned须成员NULL。004将旧记录隔离为unassigned/candidate，不能据来源群自动认定旧个人归属。

## JSON字段与数据库列的边界

`settings.value`、`models.config`、`members.profile`、`messages.raw`、任务载荷与历史snapshot内部的键不是独立SQL列。它们由公共契约及对应服务解释，PostgreSQL仅验证JSON本身与显式CHECK；TypeScript接口不能自动验证数据库中的旧JSON。

- `settings[app]`：paused、人设、各用途模型ID、proactive限频、network服务选择、embedding模型与version。密钥写入意图必须剥离。
- `settings[hunt]`：enabled、threshold、cooldownSeconds、version、enabledAt、prompt、图库版本、启用参考ID及成员白名单等；012历史种子enabled=true不是新安装最终行为，HuntGallery初始化空图库时会关闭追猎。
- `models.config`：id/name/protocol/model/baseUrl/contextWindow、工具/视觉能力及pricing；hasApiKey是回包状态，不是密钥。
- `messages.raw`：accountId、sourceMessageId、messageType、identityStatus/memberId及UI证据来源/代次等；候选昵称不能提升为可信身份。
- `model_calls.usage/pricing`：用量和单价快照；缺少必要缓存价格或实际用量时费用保持NULL。

## 桥接SQLite逐字段字典

SQLite本地持久化与PostgreSQL服务端持久化相互独立，不能用“服务端有消息”推断桥接已收到ACK。`bridge/store.py` 的 WAL 与在线备份用于并发/恢复；SQLite字段类型不会替代协议运行时校验。

### SQLite `inbox`

| 字段          | 存储定义                            | 含义与目的                                                                          |
| ------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| `seq`         | `INTEGER PRIMARY KEY AUTOINCREMENT` | 本地接收顺序，保证重放按观察顺序，不依赖消息内容排序。                              |
| `id`          | `TEXT UNIQUE`                       | 稳定事件ID；重传不会重复入箱，服务端ACK后移除，超过30天也可由expire_inbox过期删除。 |
| `payload`     | `TEXT`                              | 序列化完整事件JSON；重连时可重放，包含聊天资料因此不能公开。                        |
| `received_at` | `TEXT`                              | 本地入箱ISO 8601时间；判断积压和清理，与事件观察时间分开。                          |

### SQLite `sends`

| 字段      | 存储定义                   | 含义与目的                                                                                       |
| --------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `id`      | `TEXT PRIMARY KEY`         | 服务端commandId；重复命令查同一账本而不是再次发送。                                              |
| `status`  | `TEXT`                     | executing/sent/not_sent/unknown等账本状态；进程恢复时对中断executing保守转unknown。              |
| `detail`  | `TEXT`                     | 结果或拒绝原因；辅助人工核查，不能据此自动重发unknown。                                          |
| `context` | `TEXT NOT NULL DEFAULT ''` | 发送目标/载荷上下文的稳定绑定值；重复commandId若上下文不同则拒绝，防止同一指令换群或换内容重发。 |

### SQLite `image_uploads`

| 字段         | 存储定义           | 含义与目的                                                             |
| ------------ | ------------------ | ---------------------------------------------------------------------- |
| `id`         | `TEXT PRIMARY KEY` | 附件上传ID；与事件ACK协调，重连不生成新附件意图。                      |
| `payload`    | `TEXT`             | 上传所需JSON载荷；图片私有内容不得提交到源码库。                       |
| `created_at` | `TEXT NOT NULL`    | 本地登记ISO 8601时间（NOT NULL）；用于过期判断，不能表示服务端已收取。 |

### SQLite `snapshots`

| 字段      | 存储定义           | 含义与目的                                                 |
| --------- | ------------------ | ---------------------------------------------------------- |
| `chat_id` | `TEXT PRIMARY KEY` | 每群一份对齐状态，防止不同群的UI快照混用。                 |
| `payload` | `TEXT`             | 对齐指纹等序列化状态；保留期清理不应借快照恢复已清理正文。 |

## 迁移与修改规则

迁移锁是 `pg_advisory_xact_lock(hashtext(...))`，只协调遵守相同锁的执行者，并随事务结束自动释放。SQL文件、账本登记、默认app设置在同一事务提交；失败回滚不能伪装初始化成功。账本不校验SQL文件checksum；已经运行的迁移改注释不会重新执行，新结构仍必须增加新编号迁移。

未来新增字段至少说明：保存什么、为什么已有字段不能替代、NULL/默认值表示什么、哪个流程写/读、重试与删除如何处理、是否敏感以及需要什么约束/索引。
