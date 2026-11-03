# 启动已有安装；只在缺少构建文件时构建，不更新依赖、不登录或重启微信。
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
docker compose up -d --quiet-pull
if ($LASTEXITCODE -ne 0) {
  throw '基础服务启动失败，请先打开 Docker Desktop。'
}
if (-not (Test-Path -LiteralPath 'apps/web/dist/client/index.html')) {
  npm run build
  if ($LASTEXITCODE -ne 0) {
    throw '网页构建失败。'
  }
}
npm start
