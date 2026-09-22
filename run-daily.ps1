# 每日运行包装脚本 —— 由「install-daily-task.bat」注册成 Windows 计划任务
# 手动运行:
#   powershell -ExecutionPolicy Bypass -File run-daily.ps1
#
# 作用:采集一次 -> 生成报告 -> 有告警/失败时推送通知(需在控制台「通知推送」里配好渠道)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $root "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$stamp = Get-Date -Format "yyyy-MM-dd"
$logFile = Join-Path $logDir "run-$stamp.log"
$utf8 = New-Object System.Text.UTF8Encoding $true

function Write-Log([string]$text) {
  [System.IO.File]::AppendAllText($logFile, $text + "`r`n", $utf8)
}

Write-Log "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] === 开始采集 ==="

# 采集(输出统一写入日志,UTF-8 BOM,记事本可直接看)
$out = & node (Join-Path $root "monitor.mjs") 2>&1 | Out-String
Write-Log $out
$code = $LASTEXITCODE

Write-Log "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] === 结束,退出码 $code ==="

# 退出码:0=正常 1=有告警 2=有采集失败
# 通知已由 monitor.mjs 按 config.json 的 notify 配置自动推送(默认只在有告警/失败时推)
if ($code -eq 1) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 有告警触发(通知已按配置推送)" }
if ($code -eq 2) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 有采集失败(通知已按配置推送)" }

exit $code