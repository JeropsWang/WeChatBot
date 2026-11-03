/** 统一使用项目虚拟环境并传递桥接模块搜索路径，避免误用系统 Python。 */
import { spawn } from 'node:child_process';
import { resolve, delimiter } from 'node:path';
const executable = resolve(
  process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python',
);
const child = spawn(executable, process.argv.slice(2), {
  stdio: 'inherit',
  env: {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONPATH:
      resolve('bridge') + (process.env.PYTHONPATH ? delimiter + process.env.PYTHONPATH : ''),
  },
});
child.on('error', () => {
  console.error('项目 Python 环境不可用，请先运行 scripts/setup.ps1');
  process.exitCode = 1;
});
child.on('exit', (code) => (process.exitCode = code ?? 1));
