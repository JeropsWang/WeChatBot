/**
 * 应用装配入口（composition root）：创建共享服务实例、连接它们的依赖，
 * 注册输入校验、会话认证、业务路由与退出清理。具体业务规则仍由各 Service / Pipeline 执行。
 *
 * 这里的 Schema 是 HTTP 边界的运行时校验规则，不是数据库表定义；TypeScript 类型
 * 在运行时会被擦除，因此外部 JSON 即使满足前端类型，也必须重新经过 Zod 校验。
 * z.object 默认剔除未声明的键；这与仅在编译时生效的类型断言不同。
 * Pi 使用 TypeScript 并不决定系统规模或架构；文件过大应先按职责提取模块，
 * 是否拆成微服务取决于独立部署、资源隔离等需要，不能仅凭参数数量决定。
 *
 * 数据库迁移失败时保留健康检查和初始化状态入口，业务接口返回未就绪状态。
 * 管理员接口使用 Cookie 会话；桌面桥接使用独立 Bearer 令牌，两者不能混用。
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, access, open } from 'node:fs/promises';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { join, resolve, extname } from 'node:path';
import { z } from 'zod';
import { extractText } from 'unpdf';
import { Database } from './db.js';
import { config, modelConcurrency } from './config.js';
import { SecretStore } from './secrets.js';
import { BridgeHub } from './channel.js';
import { ModelGateway } from './models.js';
import { KnowledgeService } from './knowledge.js';
import { Pipeline, safeError } from './pipeline.js';
import { createNetworkProvider, fetchPage } from './network.js';
import { deepseekBaseUrl, deepseekSecretId } from './deepseek.js';
import { AppCache } from './cache.js';
import { UsageStore } from './usage.js';
import { getSearchSettings } from './search-settings.js';
import { MemoryManager } from './memory-management.js';
import { MembersService } from './members.js';
import { CommunityService } from './community.js';
import { ChatImagesService } from './chat-images.js';
import { HuntService, getHuntSettings, saveHuntSettings, huntWhitelistMembers } from './hunt.js';
import { LocalImageMatcher, type ImageMatcher } from './image-matcher.js';
import { huntQueue } from './hunt-queue.js';
import { HuntGallery } from './hunt-gallery.js';
import { MediaService } from './media.js';
import { registerRevampRoutes } from './revamp-routes.js';
import { pageQuery } from './pagination.js';
import type { AppSettings } from '../../packages/contracts.js';
/** 人设配置：描述回复风格和示例，不是用户身份档案，也不指定模型厂商。
 * .parse() 会在路由处理前拒绝类型/长度错误；枚举约束用于保持前后端取值一致。
 */
const personaSchema = z.object({
  /** 固定人设指令；来自管理员配置，区别于不可信的群消息和网页正文。 */
  prompt: z.string().max(30000),

  /** 回复长度偏好，实际预算和硬性字数限制由回复策略执行。 */
  length: z.enum(['简短', '适中', '详细']),

  /** 语体偏好；与 humor、emoji 一起组成可配置风格。 */
  formality: z.enum(['自然', '正式']),
  humor: z.enum(['克制', '偶尔幽默', '活泼']),
  emoji: z.enum(['不用', '偶尔', '经常']),

  /** 示例对话，供模型理解期望表达方式，不是要发送的历史消息。 */
  examples: z.string().max(10000),
});
/** 通用 HTTP(S) 地址校验器，被模型、搜索和嵌入服务共用。
 * refine 在基本字符串校验之后执行自定义判断；URL 构造失败也转换成校验失败。
 * 禁止 URL 内嵌用户名/密码，避免凭据跟随配置或日志传播。允许本机模型地址，
 * 因此这不是“仅公网地址”的 SSRF 防护；读取不可信网页的公网限制在 network 模块实现。
 */
const endpoint = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const u = new URL(value);
      return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
    } catch {
      return false;
    }
  }, '请输入HTTP或HTTPS服务地址');
/** 模型服务配置。protocol 是请求/响应协议，model 是厂商模型标识；两者不是同一个概念。
 * 能力开关来自管理员声明，不自动证明厂商支持；连通性和工具/视觉能力需要实际验证。
 * optional 允许不传字段，nullable 允许显式 null，default 只在缺失时补默认值。
 */
const modelSchema = z.object({
  /** 管理界面的显示名；可与厂商 model 标识不同。 */
  name: z.string().trim().min(1).max(100),

  /** 协议适配选择；openai 是 Responses 路径，openai-compatible 是兼容聊天路径。 */
  protocol: z.enum(['openai-compatible', 'openai', 'anthropic', 'google']),

  /** 实际提交给厂商的模型 ID；不能仅凭界面显示名确定。 */
  model: z.string().trim().min(1).max(200),

  /** 服务根地址；模型/嵌入可使用本机服务，保留与所选协议对应的路径。 */
  baseUrl: endpoint,
  /** 上下文容量（token），用于预算裁剪；此处范围校验不验证厂商真实上限。 */
  contextWindow: z.number().int().min(2048).max(2000000),

  /** 允许请求工具调用；错误声明可能导致厂商拒绝请求。 */
  supportsTools: z.boolean(),

  /** 允许选择为视觉模型；缺失时默认 false，避免旧配置被误当成视觉模型。 */
  supportsVision: z.boolean().default(false),

  /** 可选人工单价；没有价格时费用应保持未知，不自动当作零费用。 */
  pricing: z
    .object({
      /** 每百万输入 token 单价；币种由 currency 指定。 */
      inputPerMillion: z.number().nonnegative(),

      /** 每百万输出 token 单价。 */
      outputPerMillion: z.number().nonnegative(),

      /** 每百万缓存读取 token 单价，缺失时不能推算依赖此价格的完整费用。 */
      cacheReadPerMillion: z.number().nonnegative().optional(),

      /** 每百万缓存写入 token 单价；与普通输入价格分开统计。 */
      cacheWritePerMillion: z.number().nonnegative().optional(),

      /** 单价币种标识；服务不据此自动执行汇率换算。 */
      currency: z.string().trim().min(1).max(12),
    })
    .nullable()
    .optional(),

  /** 仅供本次写入密钥库的明文输入；不随普通配置持久化或原样回传。省略或空串保留原密钥，清空需另传 clearApiKey。 */
  apiKey: z.string().max(8192).optional(),

  /** 显式删除已有密钥；同时提交非空 apiKey 时，保存逻辑优先使用新密钥。 */
  clearApiKey: z.boolean().optional(),
});
/** 管理员维护的长期记忆条目，不是模型上下文窗口或模型参数。
 * visibility / scopeChatId / memberId 描述检索归属；具体跨群与成员隔离还由记忆服务检查。
 * pinned 表示人工固定，status 表示可信度处理阶段，不能把候选/冲突条目当成已确认事实。
 */
const memorySchema = z.object({
  /** 可检索的记忆正文；长度上限控制存储和提示词输入规模。 */
  content: z.string().trim().min(1).max(4000),

  /** 人工分类，不代表权限或身份可信度。 */
  category: z.enum(['事实', '偏好', '关系', '事件', '经验']),
  tags: z.array(z.string().max(50)).max(30).default([]),

  /** 固定条目标记；用于保护人工维护内容，避免自动整理随意改写。 */
  pinned: z.boolean().default(false),

  /** active 可用、candidate 待确认、conflicted 存在冲突。 */
  status: z.enum(['active', 'candidate', 'conflicted']).default('active'),

  /** global 共享、chat 群级、member 成员级、unassigned 待分配；归属字段须对应。 */
  visibility: z.enum(['global', 'chat', 'member', 'unassigned']).optional(),

  /** 归属群 ID；nullable 允许无群归属，不等于授权跨群访问。 */
  scopeChatId: z.uuid().nullable().optional(),

  /** 成员 ID；与 scopeChatId 共同确定成员记忆的隔离边界。 */
  memberId: z.uuid().nullable().optional(),
});
const settingsSchema = z.object({
  /** 全局自动回复开关；由运行变为暂停时还要取消旧任务，不能仅改页面状态。 */
  paused: z.boolean(),
  persona: personaSchema,
  /** 聊天模型配置 ID；判断与记忆角色未另选时由业务层按其回退规则使用。 */
  chatModelId: z.string(),
  /** 主动参与判断模型配置 ID，不是模型名称。 */
  decisionModelId: z.string(),
  /** 记忆提取/整理使用的模型配置 ID。 */
  memoryModelId: z.string(),
  /** 图片理解模型配置 ID；空值表示未另选，非空时保存前检查视觉能力。 */
  visionModelId: z.string().default(''),
  proactive: z.object({
    /** 单群主动参与冷却秒数；避免连续插话，不适用于所有显式命令的限频。 */
    cooldownSeconds: z.number().int().min(10).max(86400),
    /** 单群滚动小时主动参与次数上限。 */
    hourlyLimit: z.number().int().min(1).max(100),
    /** 主动参与判断最短间隔；降低对模型和群聊的打扰。 */
    judgeIntervalSeconds: z.number().int().min(20).max(600),
  }),
  network: z.object({
    enabled: z.boolean(),
    /** 自建搜索服务地址；当前 provider 不使用它时仍保留配置便于切换。 */
    searxngUrl: endpoint,
    /** 联网工具服务选择；旧配置缺失时使用 searxng。 */
    provider: z.enum(['searxng', 'deepseek']).default('searxng'),
    /** DeepSeek 联网服务地址，与聊天模型地址/密钥分开维护。 */
    deepseekBaseUrl: endpoint.default(deepseekBaseUrl),
    /** 仅供本次写入密钥库的明文输入；不随普通配置持久化或原样回传。省略或空串保留原密钥，清空需另传 clearApiKey。 */
    apiKey: z.string().trim().max(8192).optional(),
    /** 只表示服务端是否保存密钥；不能凭客户端传入此值授予服务可用性。 */
    hasApiKey: z.boolean().optional(),
    /** 显式删除已有密钥；同时提交非空 apiKey 时，保存逻辑优先使用新密钥。 */
    clearApiKey: z.boolean().optional(),
  }),
  embedding: z.object({
    enabled: z.boolean(),
    /** 服务根地址；模型/嵌入可使用本机服务，保留与所选协议对应的路径。 */
    baseUrl: endpoint,
    model: z.string().max(200),
    /** 仅供本次写入密钥库的明文输入；不随普通配置持久化或原样回传。省略或空串保留原密钥，清空需另传 clearApiKey。 */
    apiKey: z.string().max(8192).optional(),
    /** 显式删除已有密钥；同时提交非空 apiKey 时，保存逻辑优先使用新密钥。 */
    clearApiKey: z.boolean().optional(),
    /** 嵌入索引代际；服务端按配置变化递增，防止不同向量模型混用旧索引。 */
    version: z.number().int().optional(),
    /** 只表示服务端是否保存密钥；不能凭客户端传入此值授予服务可用性。 */
    hasApiKey: z.boolean().optional(),
  }),
});
/** 会话令牌使用 SHA-256 摘要做数据库查找；它不是密码 KDF，不能拿此函数代替 passwordHash。 */
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
/**
 * 密码使用随机盐 + scrypt 派生 64 字节，保存 salt:hash
 * 以便登录时重算。随机盐使相同密码不会得到相同记录；不保存明文密码。
 */
const passwordHash = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
};
/**
 * 先解析已存盐并重算 scrypt；timingSafeEqual 要求等长
 * Buffer，因此必须先比较长度，避免异常并减少按字节比较的时序泄漏。
 */
const passwordMatches = (password: string, stored: string) => {
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex'),
    actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
/** 运行时依赖注入入口。主要供启动器和隔离测试替换连接/目录/图像匹配器；不会自动从 HTTP 请求读取这些字段。 */
export interface RuntimeOptions {
  /** 可选种子清单路径，供合成图库测试注入；不应指向其他用户的私人 DATA_DIR。 */
  huntSeedManifest?: string;
  /** 调用方预定监听端口，同时用于受管桥接连接本机 WebSocket；createApp 本身不 listen。 */
  port: number;
  /** PostgreSQL 连接串；测试必须用独立 *_test 库，不输出其中凭据。 */
  databaseUrl: string;
  /** 任务队列与缓存使用的 Redis 地址；队列命名仍由 queuePrefix 隔离。 */
  redisUrl: string;
  /** 附件、桥接状态和密钥密文的根目录；不进入版本控制。 */
  dataDir: string;
  /** 桥接鉴权令牌，空值表示从数据目录读取或首次生成。 */
  bridgeToken: string;
  /** 是否启动后台消费及数据库重试；不是整个应用的只读开关。 */
  startWorkers: boolean;
  /** 前端构建根目录，必须包含 index.html 才注册静态服务。 */
  webDir: string;
  /** Redis 队列/缓存命名空间，隔离测试与其他实例；不改变数据库隔离。 */
  queuePrefix: string;
  /** 可注入匹配器，允许测试使用合成结果而不下载权重或运行真实模型。 */
  imageMatcher?: ImageMatcher;
}
/**
 * 创建尚未 listen 的 Fastify 实例及其共享服务。调用方负责监听端口并在退出时
 * app.close()；测试必须传独立数据库、目录和队列前缀。startWorkers:false
 * 只关闭后台消费，并不禁止管理员 API 自身产生写入。
 */
export async function createApp(overrides: Partial<RuntimeOptions> = {}) {
  const options = { ...config, startWorkers: true, ...overrides };
  const app = Fastify({ logger: false, bodyLimit: 8_000_000 });
  /**
   * 依赖方向：DB 保存业务状态，Cache 保存可重建缓存，UsageStore 记录真实调用，ModelGateway
   * 统一模型协议；SecretStore 只向实际服务调用提供解密后的密钥。每个应用实例只创建一份，方便统一关闭。
   */
  const db = new Database(options.databaseUrl),
    cache = new AppCache({ redisUrl: options.redisUrl, prefix: options.queuePrefix + '-cache' }),
    usage = new UsageStore(db, cache),
    gateway = new ModelGateway(usage, modelConcurrency),
    secrets = new SecretStore(options.dataDir);
  await secrets.init();
  await mkdir(join(options.dataDir, 'attachments'), { recursive: true });
  /**
   * 桥接令牌优先使用显式配置，否则复用本地文件；首次创建随机 32 字节令牌。wx
   * 表示独占新建，防止悄悄覆盖已有文件；0o600 是权限提示，Windows 实际访问还受文件 ACL 控制。不要将令牌写入
   * API 回包或日志。
   */
  let token = options.bridgeToken;
  if (!token) {
    try {
      token = (await readFile(join(options.dataDir, 'bridge.token'), 'utf8')).trim();
    } catch {
      token = randomBytes(32).toString('hex');
      await writeFile(join(options.dataDir, 'bridge.token'), token, { mode: 0o600, flag: 'wx' });
    }
  }
  /**
   * 启动时尝试迁移。失败转为 ready=false 供健康检查报告，避免静默使用不完整表结构；自动重试只在后面的
   * startWorkers 分支启用。
   */
  let ready = false,
    dependencyError = '';
  try {
    await db.migrate();
    ready = true;
  } catch (error) {
    dependencyError = safeError(error);
  }
  /**
   * SSE 客户端只接收“状态已变”的时间戳，前端再经受认证的 API
   * 获取新数据。推送不携带密钥或完整聊天正文；写失败立即移除连接。
   */
  const clients = new Set<any>();
  const changed = () => {
    for (const response of clients) {
      try {
        response.write('event: state\ndata: ' + JSON.stringify({ at: Date.now() }) + '\n\n');
      } catch {
        clients.delete(response);
      }
    }
  };
  /** 图库初始化可独立失败：只阻止相关 /api/hunt 接口，并在下次访问时重试；不让缺少可选图像环境阻断普通配置与聊天。 */
  const imageMatcher = options.imageMatcher ?? new LocalImageMatcher(),
    gallery = new HuntGallery(db, options.dataDir, imageMatcher, {
      seedManifest: options.huntSeedManifest,
    });
  let galleryError = '';
  if (ready)
    try {
      await gallery.init();
    } catch (error) {
      galleryError = safeError(error);
    }
  app.addHook('preHandler', async (request) => {
    if (galleryError && request.url.startsWith('/api/hunt')) {
      try {
        await gallery.init();
        galleryError = '';
      } catch (error) {
        throw Object.assign(new Error('触发图库暂不可用：' + safeError(error)), {
          statusCode: 503,
        });
      }
    }
  });
  /**
   * 业务装配：Members 决定成员证据与归属，Hunt/Gallery 管理图片触发，ChatImages
   * 收图后通过回调入队检测；BridgeHub 负责协议，Pipeline 负责持久任务、生成与发送门禁，避免 HTTP
   * 路由自行拼出另一条发送通道。
   */
  const members = new MembersService(db),
    hunt = new HuntService(db, members, gallery);
  const chatImages = new ChatImagesService(db, options.dataDir, gateway, secrets, (c, image) =>
    hunt.enqueue(c, image),
  );
  const bridge = new BridgeHub(db, changed),
    knowledge = new KnowledgeService(db, gateway, secrets, { usage, cache }),
    community = new CommunityService(db),
    media = new MediaService(db, options.dataDir, gateway, secrets, changed),
    memory = new MemoryManager(db),
    pipeline = new Pipeline(
      db,
      bridge,
      gateway,
      secrets,
      knowledge,
      changed,
      options.redisUrl,
      options.queuePrefix,
      { cache, members, community, media, chatImages, hunt, imageMatcher },
    );
  /** 桥接收到的消息统一走持久化 ingest，复用去重/身份/入队规则，而不是直接调用模型后发送。 */
  bridge.ingest = (event) => pipeline.ingest(event);
  /**
   * 仅记录本实例启动的子进程。child 是桥接启动器，guardian 是独立的兼容守护进程；startingBridge
   * 防止并发点击生成多个桥接。
   */
  let child: ChildProcess | undefined,
    guardian: ChildProcess | undefined,
    startingBridge = false;
  let retryTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * managed/compatibility 表示本实例持有进程句柄，不代表收发已经验收；真实连接与能力仍取自
   * BridgeHub。
   */
  const processStatus = () => ({
    ...bridge.status(),
    managed: Boolean(child),
    compatibility: Boolean(guardian),
  });
  /**
   * 只停止自己启动的桥接进程树。守护进程是它的兄弟进程，不能一起强杀；必须等待其恢复客户端的临时标志。恢复未确认时抛错，不能谎报
   * 成功，也不关闭用户微信。
   */
  const stopBridge = async () => {
    const owned = child,
      guard = guardian;
    if (!owned) return false;
    // Guardian is a sibling, deliberately outside this process tree. It watches
    // the launcher handle and restores the byte even after a bridge crash.
    if (owned.pid && owned.exitCode === null) {
      if (process.platform === 'win32')
        await new Promise<void>((resolve, reject) =>
          execFile('taskkill.exe', ['/PID', String(owned.pid), '/T', '/F'], (error) =>
            error && owned.exitCode === null ? reject(error) : resolve(),
          ),
        );
      else owned.kill('SIGTERM');
    }
    if (guard && guard.exitCode === null)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('兼容守护进程尚未确认恢复，请查看运行记录')),
          8000,
        );
        guard.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        if (guard.exitCode !== null) {
          clearTimeout(timer);
          resolve();
        }
      });
    if (child === owned) child = undefined;
    if (guardian === guard) guardian = undefined;
    changed();
    return true;
  };
  /**
   * 通用插件：Cookie 解析会话，WebSocket 承载桥接控制，rate-limit
   * 限制请求频率；setup/login 另设更小的速率上限。bodyLimit 还限制了 base64 上传的整个请求体大小。
   */
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 300000 } });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  /**
   * 统一错误出口：Zod 错误转 400，并将字段路径用于表单定位；业务显式 statusCode 保留，其余转
   * 500。普通异常必须经 safeError 清理，避免将上游请求或凭据原样暴露。
   */
  app.setErrorHandler((error: any, _request, reply) => {
    const status =
      error instanceof z.ZodError
        ? 400
        : error.statusCode && error.statusCode >= 400 && error.statusCode < 600
          ? error.statusCode
          : 500;
    reply.code(status).send({
      message:
        error instanceof z.ZodError
          ? error.issues.map((i: any) => i.path.join('.') + '：' + i.message).join('；')
          : safeError(error),
    });
  });
  /**
   * 入口门禁先核查 Host/Origin 的主机名，降低 DNS 重绑定和外站网页带 Cookie
   * 访问本机服务的风险；此处允许本机不同端口，并非严格的完整 origin 等值校验。管理员 /api 使用
   * Cookie，/bridge 另由路由执行 Bearer 校验。
   */
  app.addHook('onRequest', async (request, reply) => {
    const host = (request.headers.host ?? 'localhost').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
      return reply.code(403).send({ message: '只允许本机访问' });
    }
    if (request.headers.origin) {
      let origin: URL;
      try {
        origin = new URL(request.headers.origin);
      } catch {
        return reply.code(403).send({ message: '请求来源无效' });
      }
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))
        return reply.code(403).send({ message: '不允许跨站访问工作台' });
    }
    if (!request.url.startsWith('/api/')) return;
    if (
      ['/api/setup/status', '/api/setup', '/api/login', '/api/health'].includes(
        request.url.split('?')[0],
      )
    )
      return;
    if (!ready) return reply.code(503).send({ message: '数据库尚未就绪：' + dependencyError });
    const value = request.cookies.liino_session;
    if (!value) return reply.code(401).send({ message: '请先登录工作台' });
    const session = await db.query('SELECT 1 FROM sessions WHERE id_hash=$1 AND expires_at>now()', [
      sha(value),
    ]);
    if (!session.rowCount) return reply.code(401).send({ message: '登录已过期，请重新登录' });
  });
  /**
   * 生成高熵随机会话值，只把摘要和 7 天过期时间放入 sessions；浏览器拿原值。HttpOnly 禁止页面脚本读取
   * Cookie，SameSite=strict 限制跨站携带；这是本机 HTTP 服务，因此未设置只适用于 HTTPS 的
   * secure。
   */
  const issueSession = async (reply: any) => {
    const value = randomBytes(32).toString('hex');
    await db.query("INSERT INTO sessions(id_hash,expires_at) VALUES($1,now()+interval '7 days')", [
      sha(value),
    ]);
    reply.setCookie('liino_session', value, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 604800,
    });
  };
  /**
   * 响应投影：去掉明文密钥输入字段，改为 hasApiKey 布尔状态，并补足旧联网配置。布尔值来自
   * SecretStore.has，不信任客户端传来的 hasApiKey；它不证明密钥仍有效。
   */
  const sanitizedSettings = async () => {
    const value = await db.settings();
    delete value.embedding.apiKey;
    value.embedding.hasApiKey = secrets.has('embedding');
    delete value.network.apiKey;
    delete value.network.clearApiKey;
    value.network.provider ??= 'searxng';
    value.network.deepseekBaseUrl ??= deepseekBaseUrl;
    value.network.hasApiKey = secrets.has(deepseekSecretId);
    return value;
  };
  /** 模型 config 只应存非密钥设置；回包仍主动剔除 apiKey，以兼容旧数据，密钥状态从独立密钥库读取。 */
  const models = async () =>
    (await db.query("SELECT config FROM models ORDER BY config->>'name'")).rows.map((r) => {
      const { apiKey, ...value } = r.config;
      return { ...value, hasApiKey: secrets.has('model:' + value.id) };
    });
  /** 启动页聚合查询，返回真实计数、脱敏配置、模型和桥接状态；unknown 是需要人工核查的发送数，不能算作成功发送。 */
  const overview = async () => {
    const counts = (
      await db.query(
        "SELECT (SELECT count(*)::int FROM memories WHERE status='active') memories,(SELECT count(*)::int FROM memories WHERE status IN ('candidate','conflicted')) candidates,(SELECT count(*)::int FROM documents) documents,(SELECT count(*)::int FROM tasks WHERE state IN ('pending','running','retrying')) pending,(SELECT count(*)::int FROM sends WHERE status='unknown') unknown",
      )
    ).rows[0];
    return {
      settings: await sanitizedSettings(),
      models: await models(),
      chats: await db.chats(),
      bridge: processStatus(),
      counts,
    };
  };
  /** 健康/初始化/登录接口是认证白名单，但仍经过 Host/Origin 门禁。健康状态不等同于微信可用或模型连通。 */
  app.get('/api/health', async () => ({ ready, dependencyError, bridge: bridge.status() }));
  app.get('/api/setup/status', async (request) => {
    if (!ready)
      return { ready: false, initialized: false, authenticated: false, error: dependencyError };
    const initialized = Boolean((await db.query('SELECT 1 FROM admins')).rowCount);
    const value = request.cookies.liino_session;
    const authenticated = Boolean(
      value &&
        (
          await db.query('SELECT 1 FROM sessions WHERE id_hash=$1 AND expires_at>now()', [
            sha(value),
          ])
        ).rowCount,
    );
    return { ready: true, initialized, authenticated };
  });
  /**
   * 单管理员首次设置：id=1 的唯一约束配合 ON CONFLICT 防止两个请求同时创建管理员；冲突返回
   * 409，不用后提交的密码覆盖已有管理员。
   */
  app.post(
    '/api/setup',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!ready) return reply.code(503).send({ message: '数据库尚未就绪' });
      const { password } = z.object({ password: z.string().min(12).max(200) }).parse(request.body);
      const inserted = await db.query(
        'INSERT INTO admins(id,password_hash) VALUES(1,$1) ON CONFLICT(id) DO NOTHING RETURNING id',
        [passwordHash(password)],
      );
      if (!inserted.rowCount) return reply.code(409).send({ message: '管理员已创建，请登录' });
      await issueSession(reply);
      return { ok: true };
    },
  );
  /** 登录只验证已存密码摘要，成功签发新会话；失败统一返回密码不正确，避免区分管理员不存在与密码错误。 */
  app.post(
    '/api/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!ready) return reply.code(503).send({ message: '数据库尚未就绪' });
      const { password } = z.object({ password: z.string().max(200) }).parse(request.body);
      const admin = (await db.query('SELECT password_hash FROM admins WHERE id=1')).rows[0];
      if (!admin || !passwordMatches(password, admin.password_hash))
        return reply.code(401).send({ message: '密码不正确' });
      await issueSession(reply);
      return { ok: true };
    },
  );
  /** 退出同时删除服务端会话和清除浏览器 Cookie；只清 Cookie 会使被复制的旧会话继续有效。 */
  app.post('/api/logout', async (request, reply) => {
    if (request.cookies.liino_session)
      await db.query('DELETE FROM sessions WHERE id_hash=$1', [sha(request.cookies.liino_session)]);
    reply.clearCookie('liino_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/bootstrap', overview);
  /**
   * hijack 将响应生命周期交给这里：使用原始 Node response 持续写
   * SSE；初始事件让前端刷新一次，注释心跳维持连接。close 必须清计时器，否则断线后仍会不断写旧连接。
   */
  app.get('/api/events', async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('event: state\ndata: {}\n\n');
    clients.add(reply.raw);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15000);
    reply.raw.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(reply.raw);
    });
  });
  app.get('/api/settings', sanitizedSettings);
  /**
   * 保存全量设置：先验证模型 ID 与视觉能力，再通过 updateSettings 串行更新配置。密钥是单独文件存储，并非与
   * SQL 同一事务；回包再次脱敏。暂停要取消旧任务，嵌入配置/密钥改变要换索引代际并安排重建。
   */
  app.put('/api/settings', async (request) => {
    const input = settingsSchema.parse(request.body);
    for (const id of [
      input.chatModelId,
      input.decisionModelId,
      input.memoryModelId,
      input.visionModelId,
    ].filter(Boolean)) {
      z.uuid().parse(id);
      await pipeline.model(id);
    }
    if (input.visionModelId && !(await pipeline.model(input.visionModelId)).supportsVision)
      throw Object.assign(new Error('图片识别模型必须支持视觉'), { statusCode: 400 });
    let embeddingChanged = false,
      wasPaused = true;
    const next = await db.updateSettings(async (old) => {
      const networkKey = input.network.apiKey,
        hasNetworkKey =
          Boolean(networkKey) || (!input.network.clearApiKey && secrets.has(deepseekSecretId));
      if (input.network.enabled && input.network.provider === 'deepseek' && !hasNetworkKey)
        throw Object.assign(new Error('请先填写 DeepSeek API 密钥，或关闭联网后保存'), {
          statusCode: 400,
        });
      if (networkKey) await secrets.set(deepseekSecretId, networkKey);
      else if (input.network.clearApiKey) await secrets.set(deepseekSecretId, '');
      wasPaused = old.paused;
      embeddingChanged =
        old.embedding.baseUrl !== input.embedding.baseUrl ||
        old.embedding.model !== input.embedding.model ||
        old.embedding.enabled !== input.embedding.enabled ||
        Boolean(input.embedding.apiKey) ||
        Boolean(input.embedding.clearApiKey);
      if (input.embedding.apiKey) await secrets.set('embedding', input.embedding.apiKey);
      else if (input.embedding.clearApiKey) await secrets.set('embedding', '');
      const { apiKey, hasApiKey, clearApiKey, ...embedding } = input.embedding;
      const {
        apiKey: networkApiKey,
        hasApiKey: networkHasApiKey,
        clearApiKey: networkClearApiKey,
        ...network
      } = input.network;
      return {
        ...input,
        network,
        embedding: {
          ...embedding,
          version: embeddingChanged ? old.embedding.version + 1 : old.embedding.version,
        },
      };
    });
    if (next.paused && !wasPaused) await pipeline.stopAll();
    if (embeddingChanged) await knowledge.reindexAll();
    changed();
    return sanitizedSettings();
  });
  app.get('/api/models', models);
  /**
   * POST/PUT 共用模型保存规则。apiKey/clearApiKey 属于密钥操作指令，不进入 config
   * JSON；非空新密钥优先于 clear。ON CONFLICT 以稳定 UUID 更新，避免修改名称产生另一套模型引用。
   */
  async function saveModel(request: any) {
    const id = request.params?.id ? z.uuid().parse(request.params.id) : randomUUID();
    const input = modelSchema.parse(request.body);
    const { apiKey, clearApiKey, pricing, ...fields } = input;
    if (apiKey) await secrets.set('model:' + id, apiKey);
    else if (clearApiKey) await secrets.set('model:' + id, '');
    const value = { ...fields, id, ...(pricing ? { pricing } : {}) };
    await db.query(
      'INSERT INTO models(id,config) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET config=EXCLUDED.config',
      [id, value],
    );
    changed();
    return { ...value, hasApiKey: secrets.has('model:' + id) };
  }
  app.post('/api/models', saveModel);
  app.put('/api/models/:id', saveModel);
  /** 删除模型后同时移除密钥并清空引用该 ID 的角色配置，避免后续任务继续解析一个不存在的模型。 */
  app.delete('/api/models/:id', async (request) => {
    const id = z.uuid().parse((request.params as any).id);
    await db.query('DELETE FROM models WHERE id=$1', [id]);
    await secrets.set('model:' + id, '');
    await db.updateSettings((s) => {
      for (const key of [
        'chatModelId',
        'decisionModelId',
        'memoryModelId',
        'visionModelId',
      ] as const)
        if (s[key] === id) s[key] = '';
      return s;
    });
    changed();
    return { ok: true };
  });
  /** 使用已保存配置进行真实模型请求，会产生厂商费用和用量记录；仅测试文字回复，不证明工具调用或视觉能力可用。 */
  app.post('/api/models/:id/test', async (request) => {
    const model = await pipeline.model(z.uuid().parse((request.params as any).id));
    const started = Date.now();
    const result = await gateway.run({
      model,
      apiKey: await secrets.get('model:' + model.id),
      systemPrompt: '连通性测试。只回复“连接成功”。',
      input: '请测试文字回复',
      history: [],
      tools: [],
      context: { purpose: 'model-test' },
    });
    return { ok: true, text: result.text, milliseconds: Date.now() - started };
  });
  /**
   * 群管理只接受明确群名，bindingKey
   * 用名称编码形成桥接绑定。修改群开关/人设后使旧任务失效，再同步桥接监听配置，防止排队中的旧规则继续发送。
   */
  app.get('/api/chats', async () => db.chats());
  app.post('/api/chats', async (request) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(150) }).parse(request.body);
    const chat = await db.createChat({
      name,
      bindingKey: 'wx4py:group:' + encodeURIComponent(name),
    });
    await bridge.configure();
    changed();
    return chat;
  });
  app.patch('/api/chats/:id', async (request) => {
    const id = z.uuid().parse((request.params as any).id);
    const input = z
      .object({
        enabled: z.boolean().optional(),
        proactive: z.boolean().optional(),
        persona: personaSchema.partial().optional(),
      })
      .parse(request.body);
    const result = await db.updateChat(id, input);
    await pipeline.stopChat(id);
    await bridge.configure();
    changed();
    return result;
  });
  app.get('/api/chats/:id/messages', async (request) =>
    db.messages(z.uuid().parse((request.params as any).id)),
  );
  /**
   * 管理员显式触发真实微信验收消息；此处确实可能发送，不能把它当成无副作用的单元测试接口。先要求群已启用，再通过原有流水线和
   * outbox 执行。
   */
  app.post('/api/chats/:id/test', async (request, reply) => {
    const id = z.uuid().parse((request.params as any).id),
      chat = await db.chat(id);
    if (!chat?.enabled) {
      return reply.code(409).send({ message: '请先启用测试群监听' });
    }
    const sendId = randomUUID();
    await pipeline.reply(
      sendId,
      id,
      null,
      '【WeChatBot工作台测试】微信桥接收发验证 ' + sendId.slice(0, 8),
      'admin-test',
    );
    await pipeline.flushOutbox();
    return { ok: true, sendId };
  });
  /** 验收必须同时有近期成功测试发送、近期被 @ 的入站消息及桥接真实能力证据，不能仅靠点按钮把未知群标记为已验证。 */
  app.post('/api/chats/:id/verify', async (request, reply) => {
    const id = z.uuid().parse((request.params as any).id);
    const caps = bridge.status().capabilities;
    const sent = (
      await db.query(
        "SELECT 1 FROM sends WHERE chat_id=$1 AND kind='admin-test' AND status='sent' AND sent_at>now()-interval '30 minutes'",
        [id],
      )
    ).rowCount;
    const incoming = (
      await db.query(
        "SELECT 1 FROM messages WHERE chat_id=$1 AND direction='in' AND mentioned=true AND created_at>now()-interval '30 minutes'",
        [id],
      )
    ).rowCount;
    if (!bridge.status().connected || !caps.groupListening || !caps.mentions || !sent || !incoming)
      return reply.code(409).send({
        message:
          '尚未通过真实收发验收：请确保桥接正常、测试消息发送成功，并在群中 @机器人发送一条测试消息后重试。',
      });
    await db.query('UPDATE chats SET verified=true WHERE id=$1', [id]);
    changed();
    return { ok: true };
  });
  app.post('/api/chats/:id/stop', async (request) => {
    await pipeline.stopChat(z.uuid().parse((request.params as any).id));
    return { ok: true };
  });
  app.get('/api/bridge/status', async () => processStatus());
  /**
   * 启动只复用用户已登录的 Windows 微信窗口，不自动登录或重启微信。compatibility 默认
   * false；只在本次明确同意时启动独立守护，守护异常也触发受管桥接停止，避免在恢复不明时继续操作。
   */
  app.post('/api/bridge/start', async (request) => {
    const { compatibility } = z
      .object({ compatibility: z.boolean().default(false) })
      .parse(request.body ?? {});
    if (startingBridge) return { starting: true };
    if (bridge.status().transportConnected || child) return processStatus();
    if (guardian) throw new Error('上次兼容会话仍在恢复，请稍后再启动');
    startingBridge = true;
    try {
      const executable = resolve('.venv/Scripts/python.exe');
      await access(executable);
      const logfile = await open(join(options.dataDir, 'bridge.log'), 'a');
      const spawnOptions = {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ['ignore', logfile.fd, logfile.fd] as ['ignore', number, number],
        env: { ...process.env, BRIDGE_TOKEN: token, PYTHONUTF8: '1' },
      };
      const owned = spawn(
        executable,
        [
          'bridge/main.py',
          'run',
          '--store',
          join(options.dataDir, 'bridge.sqlite'),
          '--url',
          'ws://127.0.0.1:' + options.port + '/bridge',
        ],
        spawnOptions,
      );
      child = owned;
      owned.on('error', () => {
        void db.log('error', '微信桥接启动失败');
        if (child === owned) child = undefined;
        void logfile.close();
        changed();
      });
      owned.on('exit', () => {
        if (child === owned) child = undefined;
        void logfile.close();
        changed();
      });
      if (compatibility && owned.pid) {
        const guard = spawn(
          executable,
          [
            'scripts/runtime-accessibility-lease.py',
            '--enable-for-bridge',
            '--watch-bridge-pid',
            String(owned.pid),
            '--state-dir',
            options.dataDir,
          ],
          spawnOptions,
        );
        guardian = guard;
        const failed = () => {
          void db.log(
            'error',
            '临时无障碍兼容未能启用或恢复，请查看data/bridge.log与runtime-accessibility.json',
          );
          if (child === owned) void stopBridge().catch(() => {});
        };
        guard.on('error', failed);
        guard.on('exit', (code) => {
          if (code !== 0) failed();
          if (guardian === guard) guardian = undefined;
          changed();
        });
      }
      changed();
      return {
        starting: true,
        message: compatibility
          ? '已启动临时无障碍兼容桥接，停止时恢复原标志'
          : '已启动本机桥接，正在诊断微信窗口',
      };
    } finally {
      startingBridge = false;
    }
  });
  app.post('/api/bridge/stop', async (_request, reply) =>
    (await stopBridge())
      ? { ok: true, message: '桥接已停止，兼容守护进程已退出' }
      : reply.code(409).send({ message: '没有由工作台启动的桥接；手动启动的桥接请在原窗口停止' }),
  );
  app.post('/api/bridge/refresh', async () => {
    await bridge.configure();
    return bridge.status();
  });
  app.get('/api/bridge/chats', async () => bridge.listChats());
  /**
   * 桥接附件使用 Authorization Bearer 独立认证，不接受管理员 Cookie
   * 代替。timingSafeEqual 前先比较字节长度；上传内容的摘要、尺寸与群/事件归属由
   * ChatImagesService 继续核对。
   */
  app.post('/bridge/attachments', async (request, reply) => {
    const actual = Buffer.from(request.headers.authorization ?? ''),
      expected = Buffer.from('Bearer ' + token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return reply.code(401).send({ message: '桥接认证失败' });
    const result = await chatImages.upload(request.body);
    changed();
    return result;
  });
  /**
   * 图库接口返回当前配置、可用素材、白名单和匹配器实际状态。上传/配置保存由图库服务负责容量、解码、版本和并发约束；这里不绕过这
   * 些检查直接写表。
   */
  app.get('/api/hunt', async () => ({
    settings: await getHuntSettings(db),
    references: await gallery.all(),
    whitelistMembers: await huntWhitelistMembers(db),
    matcher: imageMatcher.status(),
  }));
  app.get('/api/hunt/references', async (request) => gallery.list(request.query));
  app.post('/api/hunt/references', async (request) => {
    const result = await gallery.upload(request.body);
    changed();
    return result;
  });
  app.get('/api/hunt/references/:id/content', async (request, reply) =>
    reply
      .header('Cache-Control', 'private, max-age=86400')
      .type('image/png')
      .send(await gallery.content((request.params as any).id)),
  );
  app.put('/api/hunt/settings', async (request) => {
    const result = await saveHuntSettings(db, request.body, gallery);
    changed();
    return result;
  });
  app.get('/api/hunt/recent', async (request) =>
    hunt.recent(z.object({ chatId: z.uuid().optional() }).parse(request.query).chatId),
  );
  app.get('/api/hunt/queue', async (request) => huntQueue(db, request.query, modelConcurrency));
  app.get('/api/hunt/images', async (request) =>
    chatImages.list(z.object({ chatId: z.uuid() }).parse(request.query).chatId),
  );
  /**
   * 手动匹配只检测已存图片，不生成追猎回复或发送微信。读取图片时校验群归属与有效期；返回前复核设置版本，避免用旧图库分数配新阈值
   * ，冲突返回 409。similarity 是余弦相似度，不是概率，触发比较严格使用 >。
   */
  app.post('/api/hunt/test', async (request) => {
    const input = z.object({ attachmentId: z.uuid(), chatId: z.uuid() }).parse(request.body);
    const image = await chatImages.content(input.attachmentId, input.chatId),
      settings = await getHuntSettings(db);
    if (!settings.enabledReferenceIds?.length)
      throw Object.assign(new Error('请先选择至少一张触发图片并保存设置'), { statusCode: 400 });
    const galleryVersion = await hunt.matchGallery(settings.version),
      result = await imageMatcher.match({ ...image, galleryVersion });
    if ((await getHuntSettings(db)).version !== settings.version)
      throw Object.assign(new Error('检测期间图库设置已改变，请重新检测'), { statusCode: 409 });
    return {
      ...result,
      threshold: settings.threshold,
      comparison: '>',
      trigger: result.similarity > settings.threshold,
      personaScope: 'single-reply',
    };
  });
  /**
   * 桥接控制通道：WebSocket 升级后仍检查 Bearer 令牌，失败以策略违规码 1008 关闭。attach
   * 之后才允许协议握手和消息处理，不通过 URL 查询串传令牌。
   */
  app.get('/bridge', { websocket: true }, (socket, request) => {
    const value = request.headers.authorization ?? '';
    const expected = 'Bearer ' + token;
    const actualBytes = Buffer.from(value),
      expectedBytes = Buffer.from(expected);
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      socket.close(1008, 'unauthorized');
      return;
    }
    bridge.attach(socket);
  });
  /**
   * 预览使用当前草稿和真实模型，可能联网/计费；不发送微信，也不保存为正式聊天或长期记忆。chatId
   * 只决定可见检索上下文，不意味着允许跨群合并成员。
   */
  app.post('/api/preview', async (request) => {
    const input = z
      .object({
        text: z.string().trim().min(1).max(8000),
        chatId: z.uuid().optional(),
        persona: personaSchema.optional(),
      })
      .parse(request.body);
    return pipeline.preview(input.text, input.chatId, input.persona);
  });
  /**
   * 长期记忆管理：服务负责分页/过滤，写入仍走 Database 的版本与检索更新逻辑；管理员手动新增明确给
   * confidence=1。删除/合并不能只改界面列表，否则旧内容仍可能进入检索。
   */
  app.get('/api/memories', async (request) =>
    memory.list(request.query as Parameters<MemoryManager['list']>[0]),
  );
  app.post('/api/memories', async (request) => {
    const value = memorySchema.parse(request.body);
    const memory = await db.saveMemory({ ...value, confidence: 1 });
    changed();
    return memory;
  });
  app.patch('/api/memories/:id', async (request) => {
    const value = memorySchema.parse(request.body);
    const result = await db.saveMemory({
      ...value,
      id: z.uuid().parse((request.params as any).id),
    });
    changed();
    return result;
  });
  app.delete('/api/memories/:id', async (request) => {
    await db.deleteMemory(z.uuid().parse((request.params as any).id));
    changed();
    return { ok: true };
  });
  app.get(
    '/api/memories/:id/versions',
    async (request) =>
      (
        await db.query(
          'SELECT version,snapshot,created_at FROM memory_versions WHERE memory_id=$1 ORDER BY version DESC',
          [z.uuid().parse((request.params as any).id)],
        )
      ).rows,
  );
  /** refine 检查 ID 不重复，防止同一记忆在合并中被计算多次；来源、版本与被合并条目的处理留给数据库业务方法统一实现。 */
  app.post('/api/memories/merge', async (request) => {
    const input = z
      .object({
        ids: z
          .array(z.uuid())
          .min(2)
          .max(20)
          .refine((a) => new Set(a).size === a.length),
        content: z.string().trim().min(1).max(4000),
        category: memorySchema.shape.category,
      })
      .parse(request.body);
    const result = await db.mergeMemories(input.ids, input.content, input.category);
    changed();
    return result;
  });
  app.get('/api/documents', async (request) =>
    memory.listDocuments(request.query as Parameters<MemoryManager['listDocuments']>[0]),
  );
  /**
   * 正文来源按 URL、上传文件、手工文字优先选择。fetchPage 负责公网读取限制；unpdf 只提取文字型 PDF，不做
   * OCR。正文入库后另存原附件，所以文件写入不属于同一个数据库事务。
   */
  app.post('/api/documents', async (request) => {
    const input = z
      .object({
        title: z.string().trim().min(1).max(200),
        content: z.string().max(500000).optional(),
        url: z.url().optional(),
        filename: z.string().max(200).optional(),
        base64: z.string().max(7000000).optional(),
        category: z.string().max(50).default('资料'),
        tags: z.array(z.string().max(50)).max(30).default([]),
      })
      .parse(request.body);
    let content = input.content ?? '',
      source = '手动导入',
      bytes: Buffer | undefined,
      extension = '';
    if (input.url) {
      const page = await fetchPage(input.url);
      content = page.content;
      source = page.url;
    } else if (input.base64) {
      bytes = Buffer.from(input.base64, 'base64');
      if (bytes.length > 5_000_000) throw new Error('文件不能超过5MB');
      extension = extname(input.filename ?? '').toLowerCase();
      if (!['.txt', '.md', '.pdf'].includes(extension))
        throw new Error('仅支持TXT、Markdown和文字型PDF');
      content =
        extension === '.pdf'
          ? (await extractText(new Uint8Array(bytes), { mergePages: true })).text
          : bytes.toString('utf8');
      source = '上传：' + (input.filename ?? input.title);
    }
    if (!content.trim()) throw new Error('没有可导入的文字；扫描版PDF需要先做文字识别');
    const document = await knowledge.importDocument({ ...input, content, source });
    if (bytes)
      await writeFile(join(options.dataDir, 'attachments', document.id + extension), bytes, {
        mode: 0o600,
      });
    changed();
    return document;
  });
  /** 删除文档和知识检索代际失效放在同一事务，避免文档已删除但缓存仍将其作为有效来源。 */
  app.delete('/api/documents/:id', async (request) => {
    await db.tx(async (c) => {
      await c.query('DELETE FROM documents WHERE id=$1', [
        z.uuid().parse((request.params as any).id),
      ]);
      await db.invalidateData(c, ['knowledge']);
    });
    changed();
    return { ok: true };
  });
  /** 检索显式传群/成员作用域，维持个人记忆隔离；reindex 只安排重建，不表示此 HTTP 请求返回时所有向量已经生成。 */
  app.post('/api/knowledge/search', async (request) => {
    const input = z
      .object({
        query: z.string().trim().min(1).max(2000),
        chatId: z.uuid().optional(),
        memberId: z.uuid().optional(),
      })
      .parse(request.body);
    return knowledge.search(input.query, { chatId: input.chatId, memberId: input.memberId });
  });
  app.post('/api/knowledge/reindex', async () => {
    await knowledge.reindexAll();
    changed();
    return { ok: true };
  });
  app.post('/api/embedding/test', async () => knowledge.embeddingTest());
  /**
   * 联网测试读取已保存服务与独立密钥，调用与模型工具相同的
   * provider。有效来源可自动收录知识库，所以测试搜索也可能写知识记录；不向微信发消息。
   */
  app.post('/api/network/search', async (request) => {
    const query = z.object({ query: z.string().trim().min(1).max(1000) }).parse(request.body).query;
    const s = await db.settings();
    if (!s.network.enabled) throw new Error('请先启用并保存联网配置');
    return createNetworkProvider(s.network, secrets, {
      onResults: (hits, context) => knowledge.rememberWebResults(hits, context),
      settings: () => getSearchSettings(db),
      cache,
      scope: 'public',
    }).search(query);
  });
  app.post('/api/network/fetch', async (request) => {
    const { url } = z.object({ url: z.string().trim().min(1).max(8192) }).parse(request.body);
    const s = await db.settings();
    if (!s.network.enabled) throw new Error('请先启用并保存联网配置');
    return createNetworkProvider(s.network, secrets, {
      onResults: (hits, context) => knowledge.rememberWebResults(hits, context),
      cache,
      scope: 'public',
    }).fetch(url);
  });
  /**
   * 任务、发送、观察消息是不同状态轴：任务 completed 不必然代表微信
   * sent。列表联合查询展示真实发送状态；skipped 过滤还包括只观察未入回复通道的消息。pageQuery
   * 使用参数绑定和稳定排序分页。
   */
  app.get('/api/tasks', async (request) => {
    const q = z.object({ status: z.string().max(30).optional() }).parse(request.query);
    const from =
      "FROM tasks t LEFT JOIN chats c ON c.id=t.chat_id LEFT JOIN outbox o ON o.id=t.id LEFT JOIN sends s ON s.id=CASE WHEN t.kind='send' THEN nullif(o.payload->>'sendId','')::uuid ELSE t.id END LEFT JOIN messages m ON m.id::text=o.payload->>'messageId'";
    const skip = q.status === 'skipped';
    return pageQuery(
      db,
      request.query,
      't.*,c.name chat_name,s.status delivery_status,m.state observation_state',
      from,
      't.created_at DESC,t.id',
      skip
        ? "(t.result->>'status'='skipped' OR (t.kind='chat' AND m.state='observed' AND s.id IS NULL))"
        : q.status
          ? 't.state=$1'
          : 'TRUE',
      q.status && !skip ? [q.status] : [],
    );
  });
  app.post('/api/tasks/:id/retry', async (request) => {
    await pipeline.retryTask(z.uuid().parse((request.params as any).id));
    changed();
    return { ok: true };
  });
  app.get('/api/sends', async (request) => {
    const q = z.object({ status: z.string().max(30).optional() }).parse(request.query);
    return pageQuery(
      db,
      request.query,
      's.*,c.name chat_name',
      'FROM sends s LEFT JOIN chats c ON c.id=s.chat_id',
      's.created_at DESC,s.id',
      q.status ? 's.status=$1' : 'TRUE',
      q.status ? [q.status] : [],
    );
  });
  /**
   * 仅管理员可处置 unknown
   * 发送。与记忆重置共享锁、群行锁、发送行锁的顺序与流水线保持一致，避免清理/新生成/人工确认交错。retry 创建新发送 ID
   * 与任务，原不确定记录保留核查结果，不原地自动重发。
   */
  app.post('/api/sends/:id/resolve', async (request, reply) => {
    const id = z.uuid().parse((request.params as any).id);
    const { action } = z
      .object({ action: z.enum(['sent', 'cancel', 'retry']) })
      .parse(request.body);
    const resolved = await db.tx(async (c) => {
      /**
       * FOR SHARE 阻止重置在本事务中途跨代；再按群 FOR UPDATE 序列化该群的状态变更。只有仍为 unknown
       * 的行允许处置，重复点击返回 409。
       */
      await c.query('SELECT id FROM memory_control WHERE id=1 FOR SHARE');
      const target = (await c.query('SELECT chat_id FROM sends WHERE id=$1', [id])).rows[0];
      if (!target) return false;
      await c.query('SELECT id FROM chats WHERE id=$1 FOR UPDATE', [target.chat_id]);
      const send = (await c.query('SELECT * FROM sends WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!send || send.status !== 'unknown') return false;
      if (action === 'sent') {
        await c.query(
          "UPDATE sends SET status='sent',sent_at=now(),detail='管理员核查确认已发送' WHERE id=$1",
          [id],
        );
        if (!send.payload_expired)
          await c.query(
            "INSERT INTO messages(id,event_id,chat_id,content,direction,observed_at,state) VALUES($1,$2,$3,$4,'out',now(),'sent') ON CONFLICT(event_id) DO NOTHING",
            [
              randomUUID(),
              'sent-' + id,
              send.chat_id,
              send.content_kind === 'image' ? '[图片]' : send.content,
            ],
          );
      } else {
        await c.query(
          "UPDATE sends SET status='cancelled',detail='管理员核查确认未发送' WHERE id=$1",
          [id],
        );
        if (action === 'retry') {
          /** 保留期已清除的正文不再可重试，不能把空载荷或旧备份当作原消息重发；未过期重试还必须重新经过发送门禁。 */
          if (send.payload_expired)
            throw Object.assign(new Error('发送正文已按保留期限清理，不能重试'), {
              statusCode: 409,
            });
          const chat = (
              await c.query('SELECT generation_epoch FROM chats WHERE id=$1 FOR UPDATE', [
                send.chat_id,
              ])
            ).rows[0],
            nextId = randomUUID();
          await c.query(
            'INSERT INTO sends(id,chat_id,source_message_id,content,kind,epoch,origin_at,content_kind,asset_id,parent_id,actor_member_id,reply_priority,review_version,reply_mode,mode_version,attachment_id,hunt_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
            [
              nextId,
              send.chat_id,
              send.source_message_id,
              send.content,
              send.kind,
              send.kind === 'hunt' ? send.epoch : chat.generation_epoch,
              send.origin_at ?? send.created_at,
              send.content_kind,
              send.asset_id,
              send.parent_id,
              send.actor_member_id,
              send.reply_priority,
              send.review_version,
              send.reply_mode,
              send.mode_version,
              send.attachment_id,
              send.hunt_version,
            ],
          );
          await db.addJob(
            c,
            'send',
            send.chat_id,
            { sendId: nextId, priority: send.reply_priority },
            'send-' + nextId,
          );
        }
      }
      await c.query(
        "UPDATE tasks t SET state=$2,updated_at=now() FROM outbox o WHERE o.id=t.id AND o.kind='send' AND o.payload->>'sendId'=$1",
        [id, action === 'sent' ? 'completed' : 'cancelled'],
      );
      return true;
    });
    if (!resolved) return reply.code(409).send({ message: '该记录已被核查或不是待核查状态' });
    changed();
    return { ok: true };
  });
  app.get('/api/logs', async (request) => {
    const q = z.object({ level: z.string().max(20).optional() }).parse(request.query);
    return pageQuery(
      db,
      request.query,
      '*',
      'FROM runtime_logs',
      'id DESC',
      q.level ? 'level=$1' : 'TRUE',
      q.level ? [q.level] : [],
    );
  });
  /** 扩展路由复用上述实例和 changed 通知，避免额外创建第二份成员/素材/记忆服务导致缓存与事务规则不一致。 */
  await registerRevampRoutes(app, { db, memory, members, community, media, usage, cache, changed });
  /**
   * 静态构建存在时才注册前端。仅 GET 的非 API 未命中请求回退 index.html，API 拼错仍返回
   * 404；开发时未构建网页可只启动后端，不将缺前端目录当作数据库故障。
   */
  try {
    await access(join(options.webDir, 'index.html'));
    await app.register(fastifyStatic, { root: options.webDir });
    app.setNotFoundHandler((request, reply) =>
      request.method === 'GET' && !request.url.startsWith('/api/')
        ? reply.sendFile('index.html')
        : reply.code(404).send({ message: '接口不存在' }),
    );
  } catch {}
  /** 隔离测试关闭后台工作进程。生产启动若数据库未就绪，每 15 秒重试迁移，成功后再启动队列消费；不能在迁移失败时先发送旧任务。 */
  if (options.startWorkers) {
    if (ready) await pipeline.start();
    retryTimer = setInterval(() => {
      if (!ready)
        void db
          .migrate()
          .then(async () => {
            ready = true;
            dependencyError = '';
            await pipeline.start();
            changed();
          })
          .catch((e) => {
            dependencyError = safeError(e);
          });
    }, 15000);
  }
  /**
   * 统一清理顺序：停止重试与 SSE，再等待受管桥接/兼容恢复，finally 关闭协议连接、图像子进程、队列、缓存与
   * DB；避免 stopBridge 抛错后仍把其它连接留在后台。
   */
  app.addHook('onClose', async () => {
    if (retryTimer) clearInterval(retryTimer);
    for (const response of clients) response.end();
    try {
      await stopBridge();
    } finally {
      bridge.close();
      imageMatcher.close();
      await pipeline.close();
      await cache.close();
      await db.close();
    }
  });
  return {
    app,
    db,
    pipeline,
    bridge,
    knowledge,
    secrets,
    memory,
    members,
    community,
    media,
    chatImages,
    hunt,
    imageMatcher,
    gallery,
    usage,
    cache,
  };
}
