# API Key 管理与配额（运营手册）

**最后更新**：2026-07-16
**适用对象**：徐总（日常签发）+ 后续运维
**线上服务**：https://api.tiici.com/

---

## 零、先看这张表（当前生效的限制）

| 限制项 | 值 | 超限表现 |
|---|---|---|
| 免费层监控点数 | **5 个** | `429`「监控点数量已达上限（5）」+ 升级链接 |
| 免费层检查频率 | **仅 6 小时** | `422`「免费层仅支持 6h 检查频率」 |
| 监控点创建 | **60 秒内最多 10 次** | `429`「监控点创建过于频繁」 |
| MCP 端点调用 | **60 秒内最多 120 次** | `429` |
| **API Key 签发** | **3 把/分钟 + 20 把/天** | `429` + `retry_after_seconds` |
| 请求体大小 | 20 MB | `413` |
| Feed 响应体 | 10 MB | 截断跳过本轮，不污染快照 |

> ⚠️ **「3 把/分钟」是我们内部操作时的实际约束** —— 批量给客户发 Key 时要分批，别一次发 5 把。

---

## 一、给客户签发一把 Key

### 操作

```bash
KEY=$(ssh feedwatch-vultr 'sudo grep -oP "FEEDWATCH_BOOTSTRAP_KEY=\K.*" /etc/feedwatch/env')

curl -X POST https://api.tiici.com/v1/apikeys \
  -H "Content-Type: application/json" \
  -H "x-api-key: $KEY" \
  -d '{"label":"客户A-2026-07"}'
```

### 返回

```json
{
  "id": "key_93b0c309",
  "key": "fw_2cf12703d5cc4c7d9d014aba2201b645",
  "note": "此明文仅显示一次，请立即保存",
  "remaining_today": "17 把"
}
```

### ⚠️ 三条铁律

| # | 规则 | 原因 |
|---|---|---|
| 1 | **明文只显示一次** | 服务端只存哈希，`GET` 拿不回来。丢了只能重发一把 |
| 2 | **立刻存进密码管理器** | 同上 |
| 3 | **不要把引导密钥给客户** | 它是最高权限（能签发 Key），泄露等于把整个账户开放 |

**引导密钥用途**：内部签发新 Key。它本身绝不能进任何客户端配置。

---

## 二、`label` 怎么起（重要）

**按「客户 + 签发年月」起名，不要用人名。**

```
✅ "客户A-2026-07"    "test-org-2026-07"
❌ "张三"             "我的key"      "test"
```

**原因**：
- **人名会离职**，人走了名字失去意义，也无法交接
- **带月份**便于判断是否该轮换（建议每 6–12 个月主动换一次）
- **禁止用 `test` / `default`** —— 上限 5 个 key 时，重名的会让人分不清哪把是哪把

---

## 三、配额是怎么算的（重要）

**配额是 per-key 的。**

```
某客户的总监控点上限 = MAX_MONITORS × 该客户名下 Key 数量
```

> 免费层 `MAX_MONITORS = 5`，所以：
> - 给客户 A 1 把 Key → 上限 5 个监控点
> - 如果误给他 3 把 Key → 上限变成 15 个

**这就是为什么必须每客户一把 Key。**

---

## 四、⚠️ 当前最大的缺口：Key 无法吊销

**这是 2026-07-16 记录的已知缺口，下个版本补。**

### 现状

- ✅ 签发：可以
- ❌ **列举**：不行 —— 服务端只存哈希，无法列出明文
- ❌ **吊销**：不行 —— 没有 `DELETE /v1/apikeys/{id}`

### 后果

**客户 Key 泄露时，唯一手段是重启服务：**

```bash
sudo systemctl restart feedwatch
```

而这会**把内存里所有 Key 一起作废** —— 包括其他正常客户的。

**验证期只有 0–5 个客户，可以接受。客户数上两位数后这会成为阻塞级问题**
（运营不敢发 Key，因为无法在不影响别人的前提下吊销某一把）。

### 临时应对（客户 Key 泄露时）

```bash
# 1. 先确认泄露范围
ssh feedwatch-vultr 'journalctl -u feedwatch --since "1 hour ago" | grep -iE "401|unauthorized"'

# 2. 重启（⚠️ 会作废所有客户 Key，需提前通知全部客户）
sudo systemctl restart feedwatch

# 3. 重签一把发给客户
curl -X POST https://api.tiici.com/v1/apikeys ...
```

⚠️ **重启后所有客户的 Key 都失效，必须逐个通知重发。** 这是这个缺口的实际代价。

---

## 五、常见错误码对照

| 码 | 含义 | 怎么办 |
|---|---|---|
| `401` | Key 无效或缺失 | 检查 `x-api-key` 头；确认服务重启后 Key 是否失效（见第四节）|
| `403` | — | **本服务不返回 403**：跨租户访问一律 `404`，避免泄露资源是否存在 |
| `404` | 监控点不存在**或不属于你** | 不区分二者是刻意设计 |
| `413` | 请求体超 20 MB | 减小 payload |
| `422` | 参数不合法 | 看 `allowed` 字段确认允许的频率 |
| `429` | 撞限流或配额 | 看 `retry_after_seconds` / `hint` / `upgrade` |
| `502` | 抓取失败 | 上游源的问题，不是我们的故障 |

---

## 六、日常运维命令

```bash
# 服务状态
systemctl status feedwatch
journalctl -u feedwatch -f              # 实时日志

# 重启（⚠️ 会作废所有 Key，见第四节）
sudo systemctl restart feedwatch

# 内存与资源
free -m && df -h /
ps -o rss= -p $(systemctl show -p MainPID --value feedwatch) | awk '{printf "Node RSS: %.0f MB\n", $1/1024}'

# 当前配置（不回显密钥）
sudo sed 's/FEEDWATCH_BOOTSTRAP_KEY=.*/***/' /etc/feedwatch/env
```

---

## 七、修改配额的正确方式

**改 `/etc/feedwatch/env`，然后重启。** 变量清单：

```bash
MAX_MONITORS=5              # 免费层监控点数
FREE_INTERVALS=21600        # 免费层允许的频率（秒），逗号分隔，可填多个
```

改完**必须重启才生效**：

```bash
sudo systemctl restart feedwatch
```

### ⚠️ 改完必须验证三处口径一致

```bash
# 1. 代码/配置读到的值
sudo grep MAX_MONITORS /etc/feedwatch/env
# 2. 接口申报的值
curl -s https://api.tiici.com/v1/usage -H "x-api-key: $KEY"
# 3. 实际强制的行为（建第 6 个应被拒）
curl -s -X POST https://api.tiici.com/v1/monitors -H "Content-Type: application/json" \
  -H "x-api-key: $KEY" -d '{"url":"https://example.com/f.xml","name":"t"}' # 连建 6 次
```

**三处必须相同。** 只改申报不强制 = 对外虚假宣传（2026-07-16 发生过，偏差 24 倍）。

> ⚠️ `deploy-linux.sh` 的 env 写入逻辑是「已存在则保留不覆盖」，
> **新增变量必须手工 `tee -a`**，重跑部署脚本写不进去。

---

## 相关文档

| 文档 | 内容 |
|---|---|
| `docs/需求/软件开发需求说明书.md` 模块 D | D4 签发限流 / D7 Key 吊销缺口的需求定义 |
| `docs/复盘/回归测试要求点清单.md` | 资源耗尽类要求点（R4.x）|
| `docs/运营手册/服务器采购与部署手册.md` | 服务器与部署 |
| `docs/运营手册/Payoneer收款链接操作手册.md` | 收款开通 |

---

> ⚠️ 配额值会随套餐设计调整。改任何一处都要同步核对：
> 落地页（`web/index.html`）、`/v1/usage` 申报、实际强制行为 —— **三处必须一致**。
