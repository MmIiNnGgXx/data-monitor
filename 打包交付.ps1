# 打包交付 —— 生成一个可以直接发给客户 / 打包出售的干净目录 + zip
# 用法:
#   powershell -ExecutionPolicy Bypass -File 打包交付.ps1
#   powershell -ExecutionPolicy Bypass -File 打包交付.ps1 -Zip          # 同时压缩成 zip
#   powershell -ExecutionPolicy Bypass -File 打包交付.ps1 -OutDir D:\交付\客户A

param(
  [string]$OutDir = "",
  [switch]$Zip
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$stamp = Get-Date -Format "yyyyMMdd"
if (-not $OutDir) { $OutDir = Join-Path $root "dist\数据监控台-$stamp" }

Write-Host ""
Write-Host "  打包交付" -ForegroundColor Cyan
Write-Host "  源目录: $root"
Write-Host "  目标:   $OutDir"
Write-Host ""

# ---- 白名单:只交付运行必需的文件(而不是黑名单排除,更安全) ----
$files = @(
  "server.mjs", "monitor.mjs", "config.json",
  "lib\fetch.mjs", "lib\extract.mjs", "lib\store.mjs", "lib\collect.mjs", "lib\report.mjs", "lib\notify.mjs",
  "public\index.html",
  "start.bat", "start.sh",
  "run-server-silent.bat", "run-daily.ps1",
  "install-autostart.bat", "uninstall-autostart.bat", "install-daily-task.bat",
  "客户使用说明.txt", "README.md", ".gitignore"
)

if (Test-Path $OutDir) {
  Write-Host "  清空已存在的目标目录..." -ForegroundColor DarkGray
  Remove-Item $OutDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$copied = 0; $missing = @()
foreach ($f in $files) {
  $src = Join-Path $root $f
  if (Test-Path $src) {
    $dst = Join-Path $OutDir $f
    $parent = Split-Path $dst -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item $src $dst -Force
    $copied++
  } else {
    $missing += $f
  }
}

# ---- 运行时目录(空目录 + 占位文件,保证解压后结构完整) ----
foreach ($d in @("data", "out", "logs")) {
  $p = Join-Path $OutDir $d
  New-Item -ItemType Directory -Force -Path $p | Out-Null
  Set-Content -Path (Join-Path $p "说明.txt") -Encoding UTF8 -Value @"
这个目录是程序运行时自动生成的:
  · data\ —— 历史快照(每个监控目标一个文件,一行一次采集)
  · out\  —— 生成的报告(HTML / CSV)
  · logs\ —— 运行日志
可以随时清空,不影响程序使用(历史数据会从清空后重新积累)。
"@
}

Write-Host "  ✅ 已复制 $copied 个文件" -ForegroundColor Green
if ($missing.Count) { Write-Host "  ⚠ 缺失 $($missing.Count) 个: $($missing -join ', ')" -ForegroundColor Yellow }

# ---- 交付前自检 ----
Write-Host ""
Write-Host "  交付前自检:" -ForegroundColor Cyan
$need = @("server.mjs", "public\index.html", "start.bat", "客户使用说明.txt", "lib\notify.mjs")
foreach ($n in $need) {
  $ok = Test-Path (Join-Path $OutDir $n)
  Write-Host ("    {0} {1}" -f $(if ($ok) { "✅" } else { "❌" }), $n)
}

# 零依赖校验:不应有 node_modules / package.json
$hasNM = Test-Path (Join-Path $OutDir "node_modules")
$hasPkg = Test-Path (Join-Path $OutDir "package.json")
Write-Host ("    {0} 零依赖(无 node_modules)" -f $(if (-not $hasNM) { "✅" } else { "❌" }))
Write-Host ("    {0} 零依赖(无 package.json)" -f $(if (-not $hasPkg) { "✅" } else { "❌" }))

# ---- 体积 ----
$size = (Get-ChildItem $OutDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ""
Write-Host ("  交付体积: {0} KB" -f [math]::Round($size / 1KB, 1))

# ---- 压缩 ----
if ($Zip) {
  $zipPath = "$OutDir.zip"
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path $OutDir -DestinationPath $zipPath -Force
  $zs = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
  Write-Host ("  ✅ 已压缩: {0}  ({1} KB)" -f $zipPath, $zs) -ForegroundColor Green
}

Write-Host ""
Write-Host "  完成。把这个目录(或 zip)发给客户即可。" -ForegroundColor Green
Write-Host ""
