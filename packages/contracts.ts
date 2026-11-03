/** 前后端与桥接共用的业务协议。类型只描述形状，所有跨进程输入仍须经运行时校验。
 * 身份、用量、价格和发送状态的未知值不得自行补成成功；修改字段需兼容已落盘任务。 */
export type MemoryCategory = '事实' | '偏好' | '关系' | '事件' | '经验';
export type TaskKind = 'chat' | 'route' | 'reply' | 'hunt-detect' | 'hunt-reply' | 'proactive' | 'send' | 'memory' | 'memory-compact' | 'index' | 'identity-sample' | 'identity-arm' | 'identity-status';
export interface AvatarDescriptor {version:1;hash:string;colors:number[]}
export interface IncomingMessage {
  eventId: string; chatId: string; accountId: string; content: string;
  observedAt: string; sourceMessageId?: string | null; senderId?: string | null;
  senderName?: string | null; botNickname?: string; isSelf: boolean; mentioned: boolean; type: 'text'|'image';
  image?:{attachmentId:string;status:'pending'|'unavailable';reason?:string;quality:'thumbnail'};
  unresolvedQuote?:boolean;
  uiCandidate?:{name:string;appearanceHash:string;eventId:string;appearanceDescriptor?:AvatarDescriptor};
  uiIdentityFailure?:{reasonCode:string;reason:string};
  identityStatus?: 'verified'|'unknown'|'conflicted'; identitySource?: string;
  nativeChatId?: string; memberId?: string | null;
}
export interface Persona {
  prompt: string; length: '简短' | '适中' | '详细'; formality: '自然' | '正式';
  humor: '克制' | '偶尔幽默' | '活泼'; emoji: '不用' | '偶尔' | '经常'; examples: string;
}
export interface ModelConfig {
  id: string; name: string; protocol: 'openai-compatible' | 'openai' | 'anthropic' | 'google';
  model: string; baseUrl: string; apiKey?: string; hasApiKey?: boolean;
  contextWindow: number; supportsTools: boolean; supportsVision?:boolean;
  pricing?: { inputPerMillion:number; outputPerMillion:number; cacheReadPerMillion?:number; cacheWritePerMillion?:number; currency:string };
}
export interface NetworkSettings {
  enabled: boolean; searxngUrl: string; provider?: 'searxng'|'deepseek'; deepseekBaseUrl?: string;
  apiKey?: string; hasApiKey?: boolean; clearApiKey?: boolean;
}
export interface AppSettings {
  paused: boolean; persona: Persona; chatModelId: string; decisionModelId: string; memoryModelId: string; visionModelId?: string;
  proactive: { cooldownSeconds: number; hourlyLimit: number; judgeIntervalSeconds: number };
  network: NetworkSettings;
  embedding: { enabled: boolean; baseUrl: string; model: string; apiKey?: string; hasApiKey?: boolean; version: number };
}
export interface Chat {
  id: string; name: string; enabled: boolean; proactive: boolean; verified: boolean;
  persona: Partial<Persona>; bindingKey: string; createdAt?: string;
}
export interface MemoryEntry {
  id: string; content: string; category: MemoryCategory; tags: string[];
  confidence: number; status: 'active' | 'candidate' | 'conflicted' | 'deleted';
  pinned: boolean; version: number; sourceChatId: string | null; sourceMessageIds: string[];
  sourceName?: string; createdAt?: string; updatedAt?: string;
  visibility?: 'global'|'chat'|'member'|'unassigned'; scopeChatId?:string|null; memberId?:string|null;
}
export interface SearchHit { title: string; url: string; content: string; fetchedAt: string; publishedAt?:string|null; updatedAt?:string|null; sourceType?:'official'|'authoritative'|'community'|'unknown';readCount?:number|null;rankReason?:string;score?:number }
export interface KnowledgeHit { id: string; content: string; title: string; source: string; score: number; kind: 'knowledge' | 'memory' }
export interface ChannelAdapter {
  status(): { connected: boolean; account?: string; capabilities: Record<string, boolean> };
  listChats(): Promise<{ name: string; bindingKey: string }[]>;
  send(command: { commandId: string; chatId: string; bindingKey: string; text: string }): Promise<{ status: 'sent' | 'not_sent' | 'unknown'; detail?: string }>;
  sendImage?(command: {commandId:string;chatId:string;bindingKey:string;data:string;sha256:string}):Promise<{status:'sent'|'not_sent'|'unknown';detail?:string}>;
  identitySample?(command:{commandId:string;chatId:string;bindingKey:string;avatarHash:string}):Promise<{status:'candidate'|'unknown';name?:string;reason?:string}>;
  identityArm?(command:{chatId:string;bindingKey:string;readName?:boolean}):Promise<{status:'armed'|'unknown';expiresInSeconds?:number}>;
  identityStatus?(command:{chatId:string;eventId:string}):Promise<{status:'current'|'candidate'|'unknown';avatarHash?:string;name?:string;identitySource?:string;reason?:string}>;
  identityReply?(command:{chatId:string;bindingKey:string;eventId:string}):Promise<{status:'candidate'|'unknown';name?:string;identitySource?:string;reason?:string;eventId?:string;appearanceHash?:string;appearanceDescriptor?:AvatarDescriptor;reasonCode?:string}>;
}
export const defaultSettings: AppSettings = {
  paused: true,
  persona: { prompt: '你是一位温柔、机智的群聊伙伴。说话自然简短，记住大家在意的事。尊重事实，不编造记忆。', length: '简短', formality: '自然', humor: '偶尔幽默', emoji: '偶尔', examples: '' },
  chatModelId: '', decisionModelId: '', memoryModelId: '', visionModelId: '',
  proactive: { cooldownSeconds: 120, hourlyLimit: 10, judgeIntervalSeconds: 20 },
  network: { enabled: false, searxngUrl: 'http://127.0.0.1:43889' },
  embedding: { enabled: false, baseUrl: 'http://127.0.0.1:11434/v1', model: 'bge-m3', version: 1 },
};
