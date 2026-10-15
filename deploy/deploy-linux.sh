#!/usr/bin/env bash
# FeedWatch 一键部署脚本（Ubuntu 24.04 / Vultr）
# 用途：在新开的 Vultr 上一键部署 Node 服务 + Nginx + systemd + certbot
# 幂等：可重复执行（已部署时会跳过并保留配置）
#
# 用法：
#   export FEEDWATCH_BOOTSTRAP_KEY='至少32位随机字符串'
#   bash deploy-linux.sh --domain api.tiici.com --email bruceonline@163.com
#
# 重要设计（来自 2026-10 事故与审查教训）：
#   1. Node 只监听 127.0.0.1，绝不用 0.0.0.0（否则绕过 Nginx 的 TLS 与访问日志）
#   2. 密钥放 /etc/feedwatch/env（权限 600），**不写进代码仓库或部署脚本**
#   3. 每一步都读回核对，不靠"应该成功了"
#   4. certbot 先用 HTTP-01，需 80 端口从外网可达 → DNS 必须已指向本机
set -euo pipefail

DOMAIN=""
EMAIL=""
SERVICE_USER="feedwatch"
APP_DIR="/opt/feedwatch"
PORT="3001"

while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email)  EMAIL="$2";  shift 2 ;;
    --port)   PORT="$2";   shift 2 ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
  echo "用法: bash deploy-linux.sh --domain <域名> --email <邮箱> [--port 3001]"
  exit 2
fi

# 密钥来自环境变量，绝不从命令行参数接收（会进 shell history）
if [[ -z "${FEEDWATCH_BOOTSTRAP_KEY:-}" ]]; then
  echo "⛔ 必须先设置 FEEDWATCH_BOOTSTRAP_KEY 环境变量（至少 32 字符）"
  echo "   export FEEDWATCH_BOOTSTRAP_KEY=\"\$(openssl rand -base64 32)\""
  exit 1
fi
if [[ ${#FEEDWATCH_BOOTSTRAP_KEY} -lt 32 ]]; then
  echo "⛔ FEEDWATCH_BOOTSTRAP_KEY 至少 32 字符，当前 ${#FEEDWATCH_BOOTSTRAP_KEY}"
  exit 1
fi

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()  { printf '\033[0;32m    ✓ %s\033[0m\n' "$*"; }
die() { printf '\033[0;31m⛔ %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "需要 root 权限（用 sudo bash ...）"

# ---------------------------------------------------------------- 1. 系统依赖
say "1/7 安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx curl git ca-certificates python3-certbot-nginx ufw 2>&1 | tail -2

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v//;s/\..*//')" -lt 20 ]]; then
  ok "安装 Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
else
  ok "Node.js 已存在: $(node -v)"
fi
node -v | grep -qE '^v(2[0-9]|[3-9][0-9])' || die "Node 版本过低: $(node -v)"
ok "Node 版本确认: $(node -v)"

# ---------------------------------------------------------------- 2. 服务用户
say "2/7 创建服务用户"
if id "$SERVICE_USER" >/dev/null 2>&1; then
  ok "用户 $SERVICE_USER 已存在"
else
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  ok "已创建系统用户 $SERVICE_USER"
fi

# ---------------------------------------------------------------- 3. 应用目录
say "3/7 部署应用代码"
if [[ -d "$APP_DIR/src" ]]; then
  ok "$APP_DIR 已存在，跳过代码部署（升级请用 --upgrade）"
else
  mkdir -p "$APP_DIR"
  # 优先从本机上传：scp -r src package.json scripts deploy "$SERVER:/opt/feedwatch/"
  echo "    ⚠️ 需先把代码传到 $APP_DIR（scp 或 git clone）"
  die "代码未就位：$APP_DIR/src 不存在"
fi

cd "$APP_DIR"
[[ -f package-lock.json ]] && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3
ok "依赖安装完成（$(node -e 'console.log(Object.keys(require("./package.json").dependencies||{}).length)') 个运行时依赖）"

# ---------------------------------------------------------------- 4. 密钥文件
say "4/7 写入密钥文件（权限 600，不入仓库）"
install -d -m 700 /etc/feedwatch
ENVFILE="/etc/feedwatch/env"
if [[ -f "$ENVFILE" ]]; then
  ok "$ENVFILE 已存在，保留原密钥（不覆盖）"
else
  cat > "$ENVFILE" <<EOF
HOST=127.0.0.1
PORT=$PORT
PUBLIC_URL=https://$DOMAIN
FEEDWATCH_BOOTSTRAP_KEY=$FEEDWATCH_BOOTSTRAP_KEY
NODE_ENV=production
EOF
  chmod 600 "$ENVFILE"
  ok "已创建 $ENVFILE（权限 600）"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

# ---------------------------------------------------------------- 5. systemd
say "5/7配置 systemd 常驻服务"
# 注意：StartLimitIntervalSec / StartLimitBurst 必须放在 [Unit] 段，
# 放在 [Service] 段会被 systemd 忽略并告警 "Unknown key name"。
cat > /etc/systemd/system/feedwatch.service <<EOF
[Unit]
Description=FeedWatch MCP - RSS/Atom change monitor API
Documentation=https://api.$DOMAIN/
After=network-online.target
Wants=network-online.target
# 崩溃退避：10 次失败内每 5 秒重试，之后拉长（必须在 [Unit]，不能放 [Service]）
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENVFILE
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5

# 安全加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable feedwatch >/dev/null 2>&1
systemctl restart feedwatch
sleep 3

if systemctl is-active --quiet feedwatch; then
  ok "服务已启动（$(systemctl is-active feedwatch)）"
else
  echo "--- journalctl 尾部 ---"
  journalctl -u feedwatch -n 30 --no-pager
  die "服务启动失败，见上方日志"
fi

# ---------------------------------------------------------------- 6. Nginx
say "6/7 配置 Nginx 反向代理"
# 先备份已有配置
[[ -f /etc/nginx/sites-available/feedwatch ]] \
  && cp /etc/nginx/sites-available/feedwatch /etc/nginx/sites-available/feedwatch.bak-$(date +%Y%m%d%H%M%S)

cat > /etc/nginx/sites-available/feedwatch <<EOF
# FeedWatch API 反向代理（自动生成：$(date '+%Y-%m-%d %H:%M')）
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # ACME HTTP-01 挑战必须走明文 80
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;

        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # MCP Streamable HTTP 需要 WebSocket 升级
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection "upgrade";

        # 长连接：抓取耗时 + 推送
        proxy_read_timeout  300s;
        proxy_send_timeout  300s;
        proxy_connect_timeout 15s;

        # SSE（如果后续加流式响应）
        proxy_buffering off;
    }
}
EOF

ln -sf /etc/nginx/sites-available/feedwatch /etc/nginx/sites-enabled/feedwatch
rm -f /etc/nginx/sites-enabled/default

nginx -t || die "Nginx 配置检查失败"
systemctl reload nginx
ok "Nginx 已配置并重载"

# ---------------------------------------------------------------- 7. 防火墙
say "7/7 配置防火墙"
ufw --force reset >/dev/null 2>&1 || true
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable >/dev/null
ok "ufw 已启用（放行 22/80/443）"
echo "    ⚠️ Vultr 控制台的 Network → Firewall 也要单独放行 22/80/443（系统层之外还有一层）"

# ---------------------------------------------------------------- 验证
say "本机自检"
sleep 2
if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  ok "后端 /health 正常"
else
  echo "--- 服务日志 ---"; journalctl -u feedwatch -n 20 --no-pager
  die "后端自检失败"
fi

LOCAL_IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
echo "    本机公网 IP: $LOCAL_IP"
echo "    请确认 DNS 中 $DOMAIN 的 A 记录已指向该 IP，否则 certbot 会失败"

cat <<EOF

================================================================
部署完成（证书步骤需单独执行）
================================================================

下一步：
  1. 确认 DNS：$DOMAIN 的 A 记录 → $LOCAL_IP
  2. 申请证书：
       certbot --nginx -d $DOMAIN --agree-tos -m $EMAIL
  3. 验证外网：
       curl -sI https://$DOMAIN/health
       echo | openssl s_client -connect $DOMAIN:443 -servername $DOMAIN 2>/dev/null \\
         | openssl x509 -noout -subject -dates

证书自动续期：certbot 自带 systemd timer（certbot.timer），已启用，无需额外配置。
检查：systemctl list-timers | grep certbot

常用运维命令：
  systemctl status feedwatch
  journalctl -u feedwatch -f
  systemctl restart feedwatch
  ss -tlnp | grep $PORT     # 确认只监听 127.0.0.1

回滚：
  systemctl stop feedwatch
  rm /etc/nginx/sites-enabled/feedwatch && nginx -t && systemctl reload nginx
  （DNS 改回旧 IP 即完成回滚，国内 6 个站点不受影响）

================================================================
EOF