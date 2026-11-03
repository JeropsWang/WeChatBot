/** 前后端与桥接共用的业务协议。类型只描述形状，所有跨进程输入仍须经运行时校验。
 * 身份、用量、价格和发送状态的未知值不得自行补成成功；修改字段需兼容已落盘任务。 */
export type MemoryCategory = '事实' | '偏好' | '关系' | '事件' | '经验';
/** 持久任务种类同时写入 outbox/tasks；新增值必须同时更新消费者分派与恢复逻辑，删除值须处理已落盘旧任务。 */
export type TaskKind =
  | 'chat'
  | 'route'
  | 'reply'
  | 'hunt-detect'
  | 'hunt-reply'
  | 'proactive'
  | 'send'
  | 'memory'
  | 'memory-compact'
  | 'index'
  | 'identity-sample'
  | 'identity-arm'
  | 'identity-status';
/** 头像外观描述用于渲染容错比较。hash 是精确外观指纹，colors 是描述特征；相似不等于唯一身份或权限证明。 */
export interface AvatarDescriptor {
  version: 1;
  hash: string;
  colors: number[];
}
/** 桥接入站事件。eventId 必须在重传时稳定、同文不同次消息时不同；observedAt 是观察时间而非服务端收到时间。sender/member/native 标识可以缺失，缺失时不得编造身份；uiCandidate 只是候选证据，不能直接授权个人记忆。图片先登记 attachmentId，二进制另行上传。 */
export interface IncomingMessage {
  eventId: string;
  chatId: string;
  accountId: string;
  content: string;
  observedAt: string;
  sourceMessageId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  botNickname?: string;
  isSelf: boolean;
  mentioned: boolean;
  type: 'text' | 'image';
  image?: {
    attachmentId: string;
    status: 'pending' | 'unavailable';
    reason?: string;
    quality: 'thumbnail';
  };
  unresolvedQuote?: boolean;
  uiCandidate?: {
    name: string;
    appearanceHash: string;
    eventId: string;
    appearanceDescriptor?: AvatarDescriptor;
  };
  uiIdentityFailure?: { reasonCode: string; reason: string };
  identityStatus?: 'verified' | 'unknown' | 'conflicted';
  identitySource?: string;
  nativeChatId?: string;
  memberId?: string | null;
}
/** 管理员人设与表达偏好。prompt/examples 是可信配置；群聊、网页与检索内容仍是不可信数据，不能因为填入某个文本字段就升级为系统指令。 */
export interface Persona {
  prompt: string;
  length: '简短' | '适中' | '详细';
  formality: '自然' | '正式';
  humor: '克制' | '偶尔幽默' | '活泼';
  emoji: '不用' | '偶尔' | '经常';
  examples: string;
}
/** 模型服务配置。protocol 决定线协议，model 是厂商模型标识，name 仅展示；supportsTools/Vision 为声明能力，不证明真实连通。apiKey 仅写入输入或内部取用，公开响应应只提供 hasApiKey。contextWindow 是上下文预算，pricing 未配置时费用应为未知而非零。 */
export interface ModelConfig {
  id: string;
  name: string;
  protocol: 'openai-compatible' | 'openai' | 'anthropic' | 'google';
  model: string;
  baseUrl: string;
  apiKey?: string;
  hasApiKey?: boolean;
  contextWindow: number;
  supportsTools: boolean;
  supportsVision?: boolean;
  pricing?: {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion?: number;
    cacheWritePerMillion?: number;
    currency: string;
  };
}
/** 联网服务选择与密钥写入意图。省略 apiKey 表示保留已有密钥；clearApiKey 才表达删除；hasApiKey 仅表示已保存凭据，不代表验证成功。DeepSeek 与 SearXNG 的服务参数不同，不能把其中一个地址当成通用搜索 API。 */
export interface NetworkSettings {
  enabled: boolean;
  searxngUrl: string;
  provider?: 'searxng' | 'deepseek';
  deepseekBaseUrl?: string;
  apiKey?: string;
  hasApiKey?: boolean;
  clearApiKey?: boolean;
}
/** 全局设置。paused 默认 true；模型 ID 空串表示未选择，不能自动补为虚构默认模型。proactive 三个限频字段单位为秒/每小时次数/秒，各约束不同阶段。embedding.version 用于识别索引对应模型代次，换模型后旧向量不能混用。 */
export interface AppSettings {
  paused: boolean;
  persona: Persona;
  chatModelId: string;
  decisionModelId: string;
  memoryModelId: string;
  visionModelId?: string;
  proactive: { cooldownSeconds: number; hourlyLimit: number; judgeIntervalSeconds: number };
  network: NetworkSettings;
  embedding: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    apiKey?: string;
    hasApiKey?: boolean;
    version: number;
  };
}
/** 对外群设置视图。bindingKey 是桥接绑定键而非管理员凭据；enabled 与 verified 分别表达管理员启用和真实收发验收，两者都不能被“桥接已连接”代替。persona 为局部覆盖，缺字段沿用全局人设。 */
export interface Chat {
  id: string;
  name: string;
  enabled: boolean;
  proactive: boolean;
  verified: boolean;
  persona: Partial<Persona>;
  bindingKey: string;
  createdAt?: string;
}
/** 长期记忆契约。sourceChatId/sourceMessageIds 记录出处，不授予读取权限；visibility/scopeChatId/memberId 才表达当前可见范围。null 与未传不同：null 可明确无归属，未传通常交由更新逻辑保留旧值。confidence 是系统置信评分，不是真实概率证明；version 用于索引/历史一致性。 */
export interface MemoryEntry {
  id: string;
  content: string;
  category: MemoryCategory;
  tags: string[];
  confidence: number;
  status: 'active' | 'candidate' | 'conflicted' | 'deleted';
  pinned: boolean;
  version: number;
  sourceChatId: string | null;
  sourceMessageIds: string[];
  sourceName?: string;
  createdAt?: string;
  updatedAt?: string;
  visibility?: 'global' | 'chat' | 'member' | 'unassigned';
  scopeChatId?: string | null;
  memberId?: string | null;
}
/** 外部搜索结果是来源资料，score、日期与阅读量均可能未知；没有值不能写成0或当前日期。来源权威性分类不等于自动信任网页指令。 */
export interface SearchHit {
  title: string;
  url: string;
  content: string;
  fetchedAt: string;
  publishedAt?: string | null;
  updatedAt?: string | null;
  sourceType?: 'official' | 'authoritative' | 'community' | 'unknown';
  readCount?: number | null;
  rankReason?: string;
  score?: number;
}
/** 统一检索命中视图。kind 区分知识切片与记忆；不同检索渠道的 score 只是排序分值，不能解释成统一的正确率。 */
export interface KnowledgeHit {
  id: string;
  content: string;
  title: string;
  source: string;
  score: number;
  kind: 'knowledge' | 'memory';
}
/** 桥接能力接口。send 的 commandId 是发件幂等键；sent 为已确认，not_sent 为确定未发，unknown 为结果不确定，不能自动重试。可选方法表示能力可能不存在，调用前须探测；identity* 返回 candidate 也不是 verified，不能绕过服务端成员核验。 */
export interface ChannelAdapter {
  status(): { connected: boolean; account?: string; capabilities: Record<string, boolean> };
  listChats(): Promise<{ name: string; bindingKey: string }[]>;
  send(command: {
    commandId: string;
    chatId: string;
    bindingKey: string;
    text: string;
  }): Promise<{ status: 'sent' | 'not_sent' | 'unknown'; detail?: string }>;
  sendImage?(command: {
    commandId: string;
    chatId: string;
    bindingKey: string;
    data: string;
    sha256: string;
  }): Promise<{ status: 'sent' | 'not_sent' | 'unknown'; detail?: string }>;
  identitySample?(command: {
    commandId: string;
    chatId: string;
    bindingKey: string;
    avatarHash: string;
  }): Promise<{ status: 'candidate' | 'unknown'; name?: string; reason?: string }>;
  identityArm?(command: {
    chatId: string;
    bindingKey: string;
    readName?: boolean;
  }): Promise<{ status: 'armed' | 'unknown'; expiresInSeconds?: number }>;
  identityStatus?(command: { chatId: string; eventId: string }): Promise<{
    status: 'current' | 'candidate' | 'unknown';
    avatarHash?: string;
    name?: string;
    identitySource?: string;
    reason?: string;
  }>;
  identityReply?(command: { chatId: string; bindingKey: string; eventId: string }): Promise<{
    status: 'candidate' | 'unknown';
    name?: string;
    identitySource?: string;
    reason?: string;
    eventId?: string;
    appearanceHash?: string;
    appearanceDescriptor?: AvatarDescriptor;
    reasonCode?: string;
  }>;
}
/** 首次初始化采用暂停、未选模型、关闭联网与嵌入的安全默认值；数据库已有设置不会因修改本常量自动迁移。所有更新应基于副本，不能修改共享默认对象。 */
export const defaultSettings: AppSettings = {
  paused: true,
  persona: {
    prompt: '你是一位温柔、机智的群聊伙伴。说话自然简短，记住大家在意的事。尊重事实，不编造记忆。',
    length: '简短',
    formality: '自然',
    humor: '偶尔幽默',
    emoji: '偶尔',
    examples: '',
  },
  chatModelId: '',
  decisionModelId: '',
  memoryModelId: '',
  visionModelId: '',
  proactive: { cooldownSeconds: 120, hourlyLimit: 10, judgeIntervalSeconds: 20 },
  network: { enabled: false, searxngUrl: 'http://127.0.0.1:43889' },
  embedding: { enabled: false, baseUrl: 'http://127.0.0.1:11434/v1', model: 'bge-m3', version: 1 },
};
