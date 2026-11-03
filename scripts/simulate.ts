/** 仅通过协议夹具和独立测试数据库验证流水线，不连接微信桌面。 */
import { spawn } from 'node:child_process';
console.log('模拟群收发验证：使用专用 liino_test 数据库和内存频道，不连接或发送真实微信。');
const child = spawn(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', 'tests/pipeline.test.ts', 'tests/model.test.ts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://liino:liino_local@127.0.0.1:54329/liino_test',
    },
  },
);
child.on('exit', (code) => (process.exitCode = code ?? 1));
