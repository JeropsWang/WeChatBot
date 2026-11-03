/** 密钥库只保存密文。Windows DPAPI 绑定当前用户；其他系统使用本地随机 AES-GCM 密钥。写入串行化并以临时文件原子替换，避免并发丢失。 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Secrets never live in application JSON or model-visible context. Windows binds ciphertext to the current user.
/** 在进程标准输入/输出之间传递 Base64 二进制，避免把明文密钥放进命令行参数。
 * Protect/Unprotect 是 Windows 当前用户级 DPAPI 操作；Base64 只是传输编码，并非加密。
 * 子进程 stderr 被排空而不回显，防止外部错误意外带出敏感内容。 */
async function dpapi(value: string, decrypt: boolean): Promise<string> {
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const script = `Add-Type -AssemblyName System.Security; $v=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[System.Security.Cryptography.ProtectedData]::${operation}($v,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    p.stdout.on('data', (chunk) => (output += chunk));
    p.stderr.resume();
    p.on('error', () => reject(new Error('Windows 密钥保护服务不可用')));
    p.on('close', (code) =>
      code === 0 ? resolve(output.trim()) : reject(new Error('密钥无法由当前 Windows 用户解密')),
    );
    p.stdin.end(value);
  });
}
export class SecretStore {
  private values: Record<string, string> = {};
  private key?: Buffer;
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private directory: string,
    private windows = process.platform === 'win32',
  ) {}
  /** 仅 ENOENT 代表首次使用；损坏 JSON 或权限错误必须上抛，不能悄悄覆盖旧密钥。
   * 0o700/0o600 在支持 POSIX 权限的平台限制目录/文件；Windows 保密性主要依赖 DPAPI 与用户权限。 */
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.values = JSON.parse(await readFile(join(this.directory, 'secrets.json'), 'utf8'));
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (!this.windows) {
      try {
        this.key = await readFile(join(this.directory, 'secret.key'));
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        this.key = randomBytes(32);
        await writeFile(join(this.directory, 'secret.key'), this.key, { mode: 0o600, flag: 'wx' });
      }
    }
  }
  /** 只报告是否配置；页面用它显示状态，不需要解密，也不返回密钥值。 */
  has(id: string) {
    return Boolean(this.values[id]);
  }
  /** 非 Windows 密文布局为 12 字节随机 IV、16 字节 GCM 认证标签、其余密文。
   * setAuthTag + final 同时校验完整性，解密失败不能当成“尚未填写”。 */
  async get(id: string): Promise<string | undefined> {
    const value = this.values[id];
    if (!value) return undefined;
    if (this.windows) return Buffer.from(await dpapi(value, true), 'base64').toString('utf8');
    const bytes = Buffer.from(value, 'base64'),
      d = createDecipheriv('aes-256-gcm', this.key!, bytes.subarray(0, 12));
    d.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([d.update(bytes.subarray(28)), d.final()]).toString('utf8');
  }
  /** 用 Promise 链串行读改写，避免并发更新各自覆盖别人的字段。
   * 开头 catch 只恢复队列可用性；本次写入失败仍通过返回 Promise 报给调用方。
   * wx 排他新建临时文件，sync 刷入文件后 rename 替换，再更新内存副本；空值表示删除。 */
  async set(id: string, value: string) {
    this.chain = this.chain
      .catch(() => {})
      .then(async () => {
        const next = { ...this.values };
        if (!value) delete next[id];
        else if (this.windows) next[id] = await dpapi(Buffer.from(value).toString('base64'), false);
        else {
          const iv = randomBytes(12),
            c = createCipheriv('aes-256-gcm', this.key!, iv),
            body = Buffer.concat([c.update(value, 'utf8'), c.final()]);
          next[id] = Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
        }
        const temporary = join(this.directory, '.secrets-' + randomUUID() + '.tmp');
        try {
          const handle = await open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(JSON.stringify(next));
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, join(this.directory, 'secrets.json'));
          this.values = next;
        } finally {
          await unlink(temporary).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      });
    return this.chain;
  }
}
