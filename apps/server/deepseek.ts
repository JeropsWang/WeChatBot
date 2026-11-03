/** 适配独立联网 Search/Fetch 协议和密钥引用。服务失败返回明确错误，不把空页或错误页当成有效知识。 */
import { setTimeout as delay } from 'node:timers/promises';

export type ApiKeySource = () => Promise<string | undefined>;
export const deepseekSecretId = 'network:deepseek';
export const deepseekBaseUrl = 'https://api.deepseek.com';

export function validateDeepSeekQuery(query: string) {
  if (!query.trim() || [...query].length > 128)
    throw new Error('DeepSeek 搜索内容须为 1–128 个字符，请缩短关键词');
}

// The deadline also bounds DNS validation and secret retrieval, which do not accept a signal.
export async function withNetworkDeadline<T>(
  milliseconds: number,
  signal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), milliseconds);
  let abort = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () =>
        reject(new Error(signal?.aborted ? '联网请求已停止' : '联网请求超过总时限，请稍后重试'));
      combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) {
        abort();
        return;
      }
      void work(combined).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', abort);
  }
}

function serviceError(status: number) {
  const reason: Record<number, string> = {
    400: '请求参数无效',
    401: 'API 密钥无效，请重新填写',
    402: '账户余额不足',
    403: '网页被安全策略拒绝',
    404: '未能提取网页正文',
    408: '请求超时，请稍后重试',
    413: '请求过大',
    429: '请求频率过高，请稍后重试',
  };
  return new Error(
    `DeepSeek 联网服务（HTTP ${status}）：${reason[status] ?? '服务暂时不可用，请稍后重试'}`,
  );
}

export class DeepSeekClient {
  constructor(
    private baseUrl: string,
    private apiKey?: ApiKeySource,
  ) {}

  async post(tool: 'search' | 'fetch', body: object, signal: AbortSignal): Promise<any> {
    const key = (await this.apiKey?.())?.trim();
    signal.throwIfAborted();
    if (!key) throw new Error('请先在联网工具中保存 DeepSeek API 密钥');
    const base = new URL(this.baseUrl);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error('DeepSeek 服务地址须为不含账号、查询参数或片段的 HTTP/HTTPS 地址');
    const path = base.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    base.pathname = path + '/v1/tools/' + tool;
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await fetch(base, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        throw new Error(
          signal.aborted
            ? '联网请求已停止或超时'
            : '无法连接 DeepSeek 联网服务，请检查服务地址与网络',
        );
      }
      if (!response.ok) {
        const retry =
          attempt === 0 &&
          (response.status === 408 || response.status === 429 || response.status >= 500);
        await response.body?.cancel();
        if (!retry) throw serviceError(response.status);
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const wait = Number.isFinite(seconds)
          ? Math.max(0, seconds * 1000)
          : retryAfter && Number.isFinite(Date.parse(retryAfter))
            ? Math.max(0, Date.parse(retryAfter) - Date.now())
            : 300;
        await delay(Math.min(wait, 2_147_483_647), undefined, { signal });
        continue;
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('DeepSeek 返回格式无效');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 2_000_000) throw new Error('DeepSeek 响应超过 2MB 读取上限');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new Error('DeepSeek 返回格式无效');
      }
    }
  }
}
