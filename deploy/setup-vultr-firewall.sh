#!/usr/bin/env bash
# Vultr 云防火墙配置（第二层）
#
# 为什么需要：deploy-linux.sh 配的 ufw 只是**系统层**。
# Vultr 还有一层**网络层**（Cloud Firewall）在宿主机上，不配等于
# 所有端口（22/80/443）对全网开放，SSH 会被持续爆破。
#
# 两种用法：
#   A. 控制台手动（推荐，无需 API Token）
#      https://my.vultr.com/settings/#firewall
#   B. API 自动化（需要 API Token）
#      export VULTR_TOKEN=xxx
#      bash deploy/setup-vultr-firewall.sh
#
# 设计要点（都来自实际踩坑）：
#   1. Allow 规则必须排在 Drop 规则之前 —— Vultr 按顺序首次匹配生效
#   2. 先建组、加规则，最后才绑定实例，避免中途把自己关在门外
#   3. 443 未开前不要绑 —— 否则后续 certbot 和 HTTPS 验证都连不上
set -euo pipefail

GROUP_NAME="${GROUP_NAME:-feedwatch-prod}"
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-}"
API="https://api.vultr.com/v2"

[[ -n "$VULTR_TOKEN" ]] || { echo "缺少 VULTR_TOKEN 环境变量"; exit 1; }
[[ -n "$SUBSCRIPTION_ID" ]] || { echo "缺少 SUBSCRIPTION_ID 环境变量"; exit 1; }

hdr=(-H "Authorization: Bearer $VULTR_TOKEN" -H "Content-Type: application/json")

echo "==> 1/4 创建防火墙组 $GROUP_NAME"
# 已存在时创建会返回 409，视为成功
GROUP_ID=$(curl -s "${hdr[@]}" -X POST "$API/firewall/groups" \
  -d "{\"description\":\"$GROUP_NAME\"}" \
  | /Users/jiayongxu/.workbuddy/binaries/node/versions/22.12.0/bin/node -e \
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(j.firewall_group?.id||'')}catch(e){console.log('')}})")
if [[ -z "$GROUP_ID" ]]; then
  echo "    组已存在，改为查询现有组"
  GROUP_ID=$(curl -s "${hdr[@]}" "$API/firewall/groups" \
    | /Users/jiayongxu/.workbuddy/binaries/node/versions/22.12.0/bin/node -e \
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const g=(j.firewall_groups||[]).find(x=>x.description==='$GROUP_NAME');console.log(g?.id||'')})")
fi
[[ -n "$GROUP_ID" ]] || { echo "无法确定防火墙组ID"; exit 1; }
echo "    组 ID: $GROUP_ID"

echo "==> 2/4 添加规则（顺序：Allow 在前，Drop 最后）"
add_rule() {
  local proto="$1" port="$2" action="$3" note="$4"
  curl -s "${hdr[@]}" -X POST "$API/firewall/rules" \
    -d "{\\"firewall_group_id\\":\\"$GROUP_ID\\",\\"protocol\\":\\"$proto\\",\\"subtype\\":\\"$3\\",\\"port\\":\\"$2\\",\\"ip_type\\":\\"v4\\",\\"source\\":\\"0.0.0.0/0\\",\\"notes\\":\\"$4\\"}" \
    >/dev/null
  echo "    ✓ $action $proto/$port — $note"
}
# 说明：Vultr API 的 IPType 必须每条规则各自指定，默认 v4
add_rule tcp 22allow   "SSH"
add_rule tcp 80  allow   "HTTP (ACME 证书签发必需)"
add_rule tcp 443 allow   "HTTPS 对外服务"
add_rule ""   ""  drop    "默认拒绝（放在最后）"

echo "==> 3/4 绑定到实例 $SUBSCRIPTION_ID"
curl -s "${hdr[@]}" -X POST "$API/firewall/groups/$GROUP_ID/instances" \
  -d "{\"instances\":[\"$SUBSCRIPTION_ID\"]}" >/dev/null
echo "    ✓ 已绑定"

echo "==> 4/4 回读校验"
curl -s "${hdr[@]}" "$API/firewall/groups/$GROUP_ID" \
  | /Users/jiayongxu/.workbuddy/binaries/node/versions/22.12.0/bin/node -e \
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const g=JSON.parse(s).firewall_group||{};console.log('规则数:',(g.rules||[]).length);(g.rules||[]).forEach(r=>console.log(' ',r.action,r.protocol,r.port||'-'))})"

echo
echo "完成。请在本机验证："
echo "  ssh feedwatch-vultr 'echo 仍可登录'# 22 通"
echo "  curl -sI http://167.179.112.40/health | head -1# 80 通"
