param([switch]$SkipInstall,[switch]$NoStart,[switch]$WithImageMatching)
$ErrorActionPreference='Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
function Assert-Success { if ($LASTEXITCODE -ne 0) { throw '上一步执行失败，请查看上方错误。' } }
if (-not $SkipInstall) {
  npm ci
  Assert-Success
  npm --prefix apps/web ci
  Assert-Success
  if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) { python -m venv .venv; Assert-Success }
  & ./.venv/Scripts/python.exe -m pip install -r bridge/requirements.lock.txt
  Assert-Success
}
if ($WithImageMatching) { & "$PSScriptRoot/setup-image-matching.ps1"; Assert-Success }
docker compose up -d --quiet-pull
Assert-Success
npm run build
Assert-Success
if (-not $NoStart) { npm start; Assert-Success }
