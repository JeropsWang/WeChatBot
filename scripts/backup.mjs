/** 备份工具：创建独立数据库快照并复制附件和密钥密文；不覆盖已有备份，跨 Windows 用户须重填密钥。 */
import { mkdir, copyFile, cp, readFile, writeFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import 'dotenv/config';
const database = new URL(
  process.env.DATABASE_URL ?? 'postgres://liino:liino_local@127.0.0.1:54329/liino',
);
if (
  !['127.0.0.1', 'localhost'].includes(database.hostname) ||
  (database.port || '5432') !== '54329'
)
  throw new Error('备份工具仅支持本机54329的compose部署');
const databaseName = decodeURIComponent(database.pathname.slice(1)),
  databaseUser = decodeURIComponent(database.username);
const destination = resolve(
  process.argv[2] ?? join('backups', new Date().toISOString().replace(/[:.]/g, '-')),
);
await mkdir(dirname(destination), { recursive: true });
await mkdir(destination, { recursive: false });
const dump = spawn(
  'docker',
  [
    'compose',
    'exec',
    '-T',
    'postgres',
    'pg_dump',
    '-U',
    databaseUser,
    '-d',
    databaseName,
    '--format=custom',
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
const exit = new Promise((res, rej) => {
  dump.on('error', rej);
  dump.on('exit', (code) => (code === 0 ? res() : rej(new Error('pg_dump失败'))));
});
await Promise.all([
  pipeline(dump.stdout, createWriteStream(join(destination, 'database.dump'), { flags: 'wx' })),
  exit,
]);
const data = resolve(process.env.DATA_DIR ?? 'data');
for (const name of ['attachments', 'secrets.json', 'bridge.token']) {
  try {
    await access(join(data, name));
    if (name === 'attachments')
      await cp(join(data, name), join(destination, name), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    else await copyFile(join(data, name), join(destination, name));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
// SQLite's online backup API snapshots a bridge inbox consistently while it runs.
try {
  await access(join(data, 'bridge.sqlite'));
  const python = resolve(
    process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python',
  );
  const script =
    'import sqlite3,sys; source=sqlite3.connect(sys.argv[1]); target=sqlite3.connect(sys.argv[2]); source.backup(target); target.close(); source.close()';
  await new Promise((res, rej) => {
    const child = spawn(
      python,
      ['-c', script, join(data, 'bridge.sqlite'), join(destination, 'bridge.sqlite')],
      { stdio: 'inherit', windowsHide: true },
    );
    child.on('error', rej);
    child.on('exit', (c) => (c === 0 ? res() : rej(new Error('桥接收件箱备份失败'))));
  });
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
await writeFile(
  join(destination, 'manifest.json'),
  JSON.stringify(
    {
      version: 1,
      createdAt: new Date().toISOString(),
      app: 'liino-workbench',
      secrets: 'Windows DPAPI密文，仅原Windows用户可解密',
      database: 'PostgreSQL custom dump',
    },
    null,
    2,
  ),
);
console.log('备份已保存：' + destination);
