import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
// 生命周期测试模拟 Windows 进程树；不要求 Linux CI 安装桌面桥接可执行文件。
const actualPlatform = process.platform;
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<any>();
  return {
    ...actual,
    access: async (path: any, ...args: any[]) =>
      String(path).replaceAll('\\', '/').endsWith('/.venv/Scripts/python.exe')
        ? undefined
        : actual.access(path, ...args),
  };
});
const fixture = vi.hoisted(() => ({
  children: [] as any[],
  spawns: [] as any[],
  kills: [] as any[],
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<any>();
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    spawn: vi.fn((file, args, options) => {
      const child: any = new EventEmitter();
      child.pid = 900001 + fixture.children.length;
      child.exitCode = null;
      child.killed = false;
      child.kill = () => {
        throw new Error('Must stop only the owned process tree, leaving guardian alive to restore');
      };
      fixture.children.push(child);
      fixture.spawns.push({ file, args, options });
      return child;
    }),
    execFile: vi.fn((file, args, callback) => {
      fixture.kills.push({ file, args });
      for (const child of fixture.children) {
        child.exitCode = 0;
        child.emit('exit', 0);
      }
      callback(null, '', '');
    }),
  };
});
import { createApp } from '../apps/server/app.js';
import { Database } from '../apps/server/db.js';
describe.skipIf(!process.env.TEST_DATABASE_URL)('explicit bridge compatibility lifecycle', () => {
  let runtime: Awaited<ReturnType<typeof createApp>>,
    cookie: string,
    bootstrap: Database,
    schema: string;
  beforeAll(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const url = new URL(process.env.TEST_DATABASE_URL!);
    if (url.pathname !== '/liino_test') throw new Error('Requires liino_test');
    schema = 'bridge_api_' + randomUUID().replaceAll('-', '');
    bootstrap = new Database(url.href);
    await bootstrap.query('CREATE SCHEMA ' + schema);
    url.searchParams.set('options', '-c search_path=' + schema + ',public');
    runtime = await createApp({
      databaseUrl: url.href,
      dataDir: 'artifacts/bridge-api-' + randomUUID(),
      startWorkers: false,
    });
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { password: 'bridge-fixture-password-only' },
    });
    cookie = response.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  });
  afterAll(async () => {
    try {
      await runtime?.app.close();
      if (bootstrap) {
        await bootstrap.query('DROP SCHEMA ' + schema + ' CASCADE');
        await bootstrap.close();
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: actualPlatform, configurable: true });
    }
  });
  it('rejects a non-boolean consent before spawning anything', async () => {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/bridge/start',
      headers: { cookie },
      payload: { compatibility: 'yes' },
    });
    expect(response.statusCode).toBe(400);
    expect(fixture.spawns).toHaveLength(0);
  });
  it('normal launch never starts the memory flag helper', async () => {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/api/bridge/start',
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(fixture.spawns).toHaveLength(1);
    expect(fixture.spawns[0].args).toContain('bridge/main.py');
    expect(
      (
        await runtime.app.inject({
          method: 'POST',
          url: '/api/bridge/stop',
          headers: { cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
  });
  it('explicit consent starts a separate guardian tied to the owned launcher and stops only its tree', async () => {
    const before = fixture.spawns.length;
    await runtime.app.inject({
      method: 'POST',
      url: '/api/bridge/start',
      headers: { cookie },
      payload: { compatibility: true },
    });
    expect(fixture.spawns).toHaveLength(before + 2);
    const bridge = fixture.children[before],
      guard = fixture.spawns[before + 1];
    expect(guard.args).toContain('--enable-for-bridge');
    expect(guard.args).toContain(String(bridge.pid));
    expect(guard.options.windowsHide).toBe(true);
    await runtime.app.inject({
      method: 'POST',
      url: '/api/bridge/stop',
      headers: { cookie },
      payload: {},
    });
    expect(fixture.kills.at(-1).args).toEqual(['/PID', String(bridge.pid), '/T', '/F']);
  });
});
