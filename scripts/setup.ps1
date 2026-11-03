# 安装锁定依赖并构建本机服务；只有显式 -WithImageMatching 才准备额外图像环境。
# -SkipInstall 仅跳过核心 npm 与桥接 pip 安装；显式 -WithImageMatching 仍会准备图像环境。
# -NoStart 只准备基础服务与构建，不启动应用后台工作进程。
param(
  [switch]$SkipInstall,
  [switch]$NoStart,
  [switch]$WithImageMatching
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

# 原生命令失败不一定产生 PowerShell 异常，因此每个安装/构建步骤都检查退出码。
function Assert-Success {
  if ($LASTEXITCODE -ne 0) {
    throw '上一步执行失败，请查看上方错误。'
  }
}

if (-not $SkipInstall) {
  npm ci
  Assert-Success
  npm --prefix apps/web ci
  Assert-Success

  if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
    python -m venv .venv
    Assert-Success
  }
  & ./.venv/Scripts/python.exe -m pip install -r bridge/requirements.lock.txt
  Assert-Success
}

if ($WithImageMatching) {
  & "$PSScriptRoot/setup-image-matching.ps1"
  Assert-Success
}

# 只启动 compose 声明的回环基础服务；不操作或重启微信客户端。
docker compose up -d --quiet-pull
Assert-Success
npm run build
Assert-Success

if (-not $NoStart) {
  npm start
  Assert-Success
}
