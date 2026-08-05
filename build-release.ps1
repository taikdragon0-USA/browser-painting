# Web Draw — 构建发布 zip
# 从 manifest.json 读取版本号,打包扩展加载所需的最小文件集,
# 输出到 dist/browser-painting-v<版本>.zip。
# 用法: powershell -ExecutionPolicy Bypass -File build-release.ps1
$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
# 注意:用 UTF-8 显式读取(PS 5.1 默认按系统 ANSI 读会乱码)
$manifestJson = [System.IO.File]::ReadAllText((Join-Path $root "manifest.json"), [System.Text.Encoding]::UTF8)
$manifest = $manifestJson | ConvertFrom-Json
$version = $manifest.version
$assetName = "browser-painting-v$version"

$staging = Join-Path $root ".release\$assetName"
$dist = Join-Path $root "dist"
$zipPath = Join-Path $dist "$assetName.zip"

# 清空旧产物
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
New-Item -ItemType Directory -Force $staging | Out-Null
New-Item -ItemType Directory -Force $dist | Out-Null

# 复制扩展必需文件(manifest.json 必须在 zip 根目录)
foreach ($f in @("manifest.json", "background.js", "content.js", "content.css", "README.md", "LICENSE")) {
  Copy-Item (Join-Path $root $f) $staging
}
Copy-Item (Join-Path $root "icons") (Join-Path $staging "icons") -Recurse

# 打包
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath
Remove-Item -Recurse -Force $staging

$size = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Output ("已生成: {0}  ({1} KB, manifest 版本 {2})" -f $zipPath, $size, $version)
