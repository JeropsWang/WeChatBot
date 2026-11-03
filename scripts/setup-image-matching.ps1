# 显式执行才允许下载公共权重；与桥接 .venv 隔离，避免重型 torch 依赖干扰桌面自动化。
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

function Assert-Success {
  if ($LASTEXITCODE -ne 0) {
    throw '图像环境准备失败，请检查网络与 Python 版本。'
  }
}

if (-not (Test-Path '.venv-image-match/Scripts/python.exe')) {
  python -m venv .venv-image-match
  Assert-Success
}

# 锁文件保证可复现；额外索引提供 CPU 版 PyTorch，不要求 GPU/CUDA。
& ./.venv-image-match/Scripts/python.exe -m pip install -r scripts/image-match-requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
Assert-Success
# 此命令只预备模型，不需要私人参考图库；日常 serve 不传 --allow-download，继续离线运行。
& ./.venv-image-match/Scripts/python.exe scripts/image_match.py prepare-model --allow-download
Assert-Success
