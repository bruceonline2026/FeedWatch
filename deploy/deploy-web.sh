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
NGINX_TEMPLATE="$REPO/deploy/nginx-site.conf"

# ⚠️ **这六个文件必须成组上传**（2026-10-17 修）
#   原实现只传 `web/index.html`，但那个文件**早就不存在了** ——
#   落地页改成了中英双文件 + 独立的隐私政策页与退款政策页。
#   于是这个脚本在第 20 行的 `[[ -f ]]` 直接退出，**静默失效了很久**：
#   谁跑它都会以为「部署过了」，实际什么都没做。
#   更糟的是文案改动后就再也无法上线 —— 线上一直是旧版本。
#
#   nginx 的映射（sites-available/feedwatch）：
#     /            → en.html /index.html  → en.html
#     /zh/         → zh.html
#     /privacy     → privacy.en.html      /zh/privacy → privacy.zh.html
#     /refund      → refund.en.html       /zh/refund  → refund.zh.html
WEB_FILES=(en.html zh.html privacy.en.html privacy.zh.html refund.en.html refund.zh.html)

missing=0
for f in "${WEB_FILES[@]}"; do
  [[ -f "$REPO/web/$f" ]] || { echo "缺少文件：web/$f"; missing=1; }
done
[[ -f "$NGINX_TEMPLATE" ]] || { echo "找不到 Nginx 模板：$NGINX_TEMPLATE"; exit 1; }
[[ $missing -eq 0 ]] || exit 1

echo "==> 1/5 创建落地页目录并上传 ${#WEB_FILES[@]} 个文件"
ssh "$HOST" "sudo mkdir -p '$WEB_DIR'"
for f in "${WEB_FILES[@]}"; do
  scp "$REPO/web/$f" "$HOST:/tmp/fw-$f"
done
for f in "${WEB_FILES[@]}"; do
  ssh "$HOST" "sudo mv /tmp/fw-$f '$WEB_DIR/$f' \
    && sudo chown root:root '$WEB_DIR/$f' \
    && sudo chmod 644 '$WEB_DIR/$f'"
  printf "    %-18s %s 字节\n" "$f" "$(wc -c < "$REPO/web/$f" | tr -d ' ')"
done

# ⚠️ 部署后**必须验证**：这套文件此前出现过「改了本地但线上没变」的情况，
#   而旧脚本不报错、无从察觉。逐个 URL 实际取一次，看字节数是否变化。
echo "    → 线上验证"
for pair in "/:en.html" "/zh/:zh.html" "/privacy:privacy.en.html" \
            "/zh/privacy:privacy.zh.html" "/refund:refund.en.html" "/zh/refund:refund.zh.html"; do
  url_path="${pair%%:*}"; file="${pair##*:}"
  local_bytes=$(wc -c < "$REPO/web/$file" | tr -d ' ')
  remote_bytes=$(ssh "$HOST" "wc -c < '$WEB_DIR/$file'" | tr -d ' ')
  if [[ "$local_bytes" != "$remote_bytes" ]]; then
    echo "    ✗ $url_path → $file 本地 $local_bytes ≠ 线上 $remote_bytes **不一致**"
    exit 1
  fi
  printf "    ✓ %-12s %s 字节\n" "$url_path" "$remote_bytes"
done

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
