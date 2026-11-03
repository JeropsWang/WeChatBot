/** 读取本机运行配置并验证绑定与并发限制。保留历史数据库和队列默认标识以兼容已有安装，真实凭据只来自运行环境。 */
import 'dotenv/config';
import { resolve } from 'node:path';
const modelConcurrency = Number(process.env.MODEL_CONCURRENCY ?? 4);
if (!Number.isInteger(modelConcurrency) || modelConcurrency < 1 || modelConcurrency > 8)
  throw new Error('MODEL_CONCURRENCY 必须是1到8的整数');
export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 4310),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://liino:liino_local@127.0.0.1:54329/liino',
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:63799',
  dataDir: resolve(process.env.DATA_DIR ?? 'data'),
  bridgeToken: process.env.BRIDGE_TOKEN ?? '',
  webDir: resolve('apps/web/dist/client'),
  queuePrefix: process.env.QUEUE_PREFIX ?? 'liino',
};
if (!['127.0.0.1', 'localhost', '::1'].includes(config.host))
  throw new Error('首版只支持本机绑定，请将 HOST 设为127.0.0.1');
export { modelConcurrency };
