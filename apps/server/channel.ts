/** 认证后的 WebSocket 桥接协议。请求通过 commandId 关联响应，断线与超时不能推断微信已发送；仅将已持久接收的消息确认为成功。 */
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { ChannelAdapter, IncomingMessage } from '../../packages/contracts.js';
import type { Database } from './db.js';
import { z } from 'zod';
import { avatarDescriptorSchema } from './avatar-descriptor.js';
const eventSchema = z.object({
  eventId: z.string().min(1).max(150),
  chatId: z.uuid(),
  accountId: z.string().max(150),
  botNickname: z.string().max(200).optional(),
  content: z.string().min(1).max(16000),
  observedAt: z.iso.datetime({ offset: true }),
  sourceMessageId: z.string().max(500).nullable().optional(),
  senderId: z.string().max(500).nullable().optional(),
  senderName: z.string().max(500).nullable().optional(),
  identityStatus: z.enum(['verified', 'unknown', 'conflicted']).optional(),
  identitySource: z.string().max(100).optional(),
  nativeChatId: z.string().max(500).nullable().optional(),
  isSelf: z.boolean(),
  mentioned: z.boolean(),
  type: z.enum(['text', 'image']),
  unresolvedQuote: z.boolean().optional(),
  image: z
    .object({
      attachmentId: z.uuid(),
      status: z.enum(['pending', 'unavailable']),
      reason: z.preprocess(
        (value) => (value === null ? undefined : value),
        z.string().max(500).optional(),
      ),
      quality: z.literal('thumbnail'),
    })
    .optional(),
  uiCandidate: z
    .object({
      name: z.string().min(1).max(200),
      appearanceHash: z.string().regex(/^[a-f0-9]{64}$/),
      eventId: z.string().min(1).max(150),
      appearanceDescriptor: avatarDescriptorSchema.optional(),
    })
    .optional(),
  uiIdentityFailure: z
    .object({ reasonCode: z.string().min(1).max(100), reason: z.string().min(1).max(500) })
    .optional(),
});
const validationDetail = (error: z.ZodError) =>
  '消息字段不合法：' +
  error.issues
    .map((issue) => issue.path.join('.') + ' (' + issue.code + ')')
    .join('；')
    .slice(0, 400);
export class BridgeHub implements ChannelAdapter {
  ingest: (event: IncomingMessage) => Promise<unknown>;
  private socket?: WebSocket;
  private details: any = { connected: false, capabilities: {} };
  private pending = new Map<
    string,
    { resolve: (value: any) => void; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(
    private db: Database,
    private changed: () => void,
  ) {
    this.ingest = (event) => db.ingest(event);
  }
  status() {
    return {
      connected: Boolean(this.socket?.readyState === 1 && this.details.connected),
      transportConnected: this.socket?.readyState === 1,
      account: this.details.account,
      capabilities: this.details.capabilities ?? {},
      detail: this.details.detail ?? '',
      diagnostics: this.details.diagnostics ?? {},
    };
  }
  attach(socket: WebSocket) {
    this.socket?.close(1000, 'replaced');
    this.socket = socket;
    socket.on('message', (raw) => {
      void this.receive(socket, raw.toString()).catch(async (error) => {
        await this.db
          .log(
            'warn',
            error instanceof z.ZodError ? validationDetail(error) : '桥接消息格式或入库失败',
          )
          .catch(() => {});
      });
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.details.connected = false;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ status: 'unknown', detail: '桥接连接在确认前断开' });
        this.pending.delete(id);
      }
      this.changed();
    });
    socket.on('error', () => {});
    void this.configure();
    this.changed();
  }
  private async receive(socket: WebSocket, raw: string) {
    if (raw.length > 300000) throw new Error('桥接帧过大');
    const message = JSON.parse(raw);
    if (message.type === 'status') {
      this.details = { ...message };
      this.changed();
      return;
    }
    if (message.type === 'result') {
      const pending = this.pending.get(message.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        pending.resolve(message.result);
      }
      return;
    }
    if (message.type === 'event') {
      try {
        const event = eventSchema
          .refine((e) => e.type !== 'image' || Boolean(e.image), '图片消息需要附件元信息')
          .parse(message.event) as IncomingMessage;
        await this.ingest(event);
        if (socket.readyState === 1)
          socket.send(JSON.stringify({ type: 'ack', eventId: event.eventId }));
        this.changed();
      } catch (error) {
        if (socket.readyState === 1)
          socket.send(
            JSON.stringify({
              type: 'nack',
              eventId: message.event?.eventId,
              code: error instanceof z.ZodError ? 'invalid_event' : 'ingest_failed',
              detail:
                error instanceof z.ZodError
                  ? validationDetail(error)
                  : '消息入库失败，保留本地待重试',
            }),
          );
        throw error;
      }
    }
    if (message.type === 'diagnostic') {
      await this.db.log('warn', String(message.detail ?? '桥接诊断').slice(0, 500));
      this.changed();
    }
  }
  async configure() {
    if (this.socket?.readyState !== 1) return;
    const chats = await this.db.chats();
    this.socket.send(
      JSON.stringify({
        type: 'configure',
        chats: chats
          .filter((c) => c.enabled)
          .map((c) => ({ id: c.id, name: c.name, bindingKey: c.bindingKey })),
      }),
    );
  }
  async request(action: string, payload: unknown): Promise<any> {
    if (this.socket?.readyState !== 1) return { status: 'not_sent', detail: '桥接未连接' };
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ status: 'unknown', detail: '桥接响应超时，请核查微信实际结果' });
      }, 30000);
      timer.unref();
      this.pending.set(requestId, { resolve, timer });
      try {
        this.socket!.send(JSON.stringify({ type: 'request', requestId, action, payload }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ status: 'not_sent', detail: '桥接不可用' });
      }
    });
  }
  async listChats() {
    const result = await this.request('list', {});
    if (!Array.isArray(result.chats)) throw new Error(result.detail ?? '无法读取群聊');
    return result.chats;
  }
  send(command: {
    commandId: string;
    chatId: string;
    bindingKey: string;
    text: string;
  }): Promise<{ status: 'sent' | 'not_sent' | 'unknown'; detail?: string }> {
    return this.request('send', command);
  }
  sendImage(command: {
    commandId: string;
    chatId: string;
    bindingKey: string;
    data: string;
    sha256: string;
  }): Promise<{ status: 'sent' | 'not_sent' | 'unknown'; detail?: string }> {
    return this.request('send_image', command);
  }
  identitySample(command: {
    commandId: string;
    chatId: string;
    bindingKey: string;
    avatarHash: string;
  }): Promise<{ status: 'candidate' | 'unknown'; name?: string; reason?: string }> {
    return this.request('identity_sample', command);
  }
  identityArm(command: {
    chatId: string;
    bindingKey: string;
    readName?: boolean;
  }): Promise<{ status: 'armed' | 'unknown'; expiresInSeconds?: number }> {
    return this.request('identity_arm', command);
  }
  identityStatus(command: { chatId: string; eventId: string }): Promise<{
    status: 'current' | 'candidate' | 'unknown';
    avatarHash?: string;
    name?: string;
    identitySource?: string;
    reason?: string;
  }> {
    return this.request('identity_status', command);
  }
  identityReply(command: { chatId: string; bindingKey: string; eventId: string }): Promise<{
    status: 'candidate' | 'unknown';
    name?: string;
    identitySource?: string;
    reason?: string;
    eventId?: string;
    appearanceHash?: string;
    reasonCode?: string;
  }> {
    return this.request('identity_reply', command);
  }
  close() {
    this.socket?.close();
  }
}
