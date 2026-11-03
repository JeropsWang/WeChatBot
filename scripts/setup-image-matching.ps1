# 显式运行才下载公共模型；聊天与桥接环境独立，日常匹配保持离线。
$ErrorActionPreference='Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
function Assert-Success { if ($LASTEXITCODE -ne 0) { throw '图像环境准备失败，请检查网络与 Python 版本。' } }
if (-not (Test-Path '.venv-image-match/Scripts/python.exe')) { python -m venv .venv-image-match; Assert-Success }
& ./.venv-image-match/Scripts/python.exe -m pip install -r scripts/image-match-requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
Assert-Success
& ./.venv-image-match/Scripts/python.exe scripts/image_match.py prepare-model --allow-download
Assert-Success
