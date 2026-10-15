#!/usr/bin/env bash
# 落地页部署脚本（可重复执行）
#
# 设计要点（都来自实际教训）：
#   1. Nginx 用 exact match（`location = /`）挂静态页，**绝不用 `location /`** ——
#      否则会把 /health、/v1/monitors、/mcp 这些 API 路由全部吞掉。
#   2. 先 `nginx -t` 再 reload —— 2026-10-13 www 站点 500 事故的教训。
#   3. 落地页目录独立 /var/www/feedwatch，不与 ACME 的 /var/www/html 混用。
#   4. 每次自动备份现有配置，带时间戳。
#
# 用法：bash deploy/deploy-web.sh [服务器别名]
set -euo pipefail

HOST="${1:-feedwatch-vultr}"
WEB_DIR="${WEB_DIR:-/var/www/feedwatch}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/web/index.html"
NGINX_TEMPLATE="$REPO/deploy/nginx-site.conf"

[[ -f "$SRC" ]]            || { echo "找不到落地页：$SRC"; exit 1; }
[[ -f "$NGINX_TEMPLATE" ]] || { echo "找不到 Nginx 模板：$NGINX_TEMPLATE"; exit 1; }

echo "==> 1/5 创建落地页目录并上传"
ssh "$HOST" "sudo mkdir -p '$WEB_DIR'"
scp "$SRC" "$HOST:/tmp/fw-index.html"
ssh "$HOST" "sudo mv /tmp/fw-index.html '$WEB_DIR/index.html' \
  && sudo chown www-data:www-data '$WEB_DIR/index.html' \
  && sudo chmod 644 '$WEB_DIR/index.html'"
echo "    字节数：$(wc -c < "$SRC" | tr -d ' ')"

echo "==> 2/5 备份现有 Nginx 配置"
ssh "$HOST" 'sudo cp /etc/nginx/sites-available/feedwatch \
  "/etc/nginx/sites-available/feedwatch.bak-$(date +%Y%m%d%H%M%S)"'
echo "    已备份"

echo "==> 3/5 应用新配置并做语法检查（失败则不 reload）"
scp "$NGINX_TEMPLATE" "$HOST:/tmp/fw-nginx.conf"
ssh "$HOST" 'sudo cp /tmp/fw-nginx.conf /etc/nginx/sites-available/feedwatch && sudo nginx -t'
echo "    语法检查通过"

echo "==> 4/5 重载并验证"
ssh "$HOST" 'sudo systemctl reload nginx && sleep 2 && \
  printf "    落地页: " && curl -s -o /dev/null -w "%{http_code}  %{size_download}B\n" --max-time 10 https://api.tiici.com/ && \
  printf "    API:    " && curl -s --max-time 10 https://api.tiici.com/health | head -c 45 && echo && \
  printf "    MCP:    " && curl -s -o /dev/null -w "%{http_code}（期望 401）\n" --max-time 10 \
    -X POST https://api.tiici.com/mcp \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"'

echo "==> 5/5 全部通过 —— 落地页已上线：https://api.tiici.com/"
