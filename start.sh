#!/usr/bin/env bash
# 数据监控台 · 一键启动(macOS / Linux)
set -e
cd "$(dirname "$0")"
mkdir -p logs

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  [错误] 没有检测到 Node.js"
  echo "  请先安装:https://nodejs.org/  (选 LTS 版本)"
  echo ""
  exit 1
fi

PORT="${1:-4210}"
echo ""
echo "  ================================================"
echo "    数据监控台  正在启动..."
echo "  ================================================"
echo ""
echo "  控制台地址: http://127.0.0.1:${PORT}/"
echo "  停止服务:   按 Ctrl+C"
echo ""

# 3 秒后自动打开浏览器(尽力而为,打不开就手动访问上面的地址)
( sleep 3; (command -v xdg-open >/dev/null && xdg-open "http://127.0.0.1:${PORT}/") || (command -v open >/dev/null && open "http://127.0.0.1:${PORT}/") || true ) &

exec node server.mjs --port="${PORT}"
