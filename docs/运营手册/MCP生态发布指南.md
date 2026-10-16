# FeedWatch — 提交到 MCP 生态

**日期**：2026-10-15
**仓库**：https://github.com/bruceonline2026/FeedWatch
**状态**：GitHub 已上线 ✅ · MCP 注册表待提交（需你在本机执行）

---

## 一、为什么要做这件事

**MCP 生态有个别的产品没有的分发渠道**：所有 MCP 客户端（Claude / Cursor / VS Code / Windsurf / Replit / Zed）都从注册表发现工具。

**一次提交，多处覆盖**：

| 注册表 | 月访问 | 提交方式 | 备注 |
|---|---|---|---|
| **官方** registry.modelcontextprotocol.io | 54K | CLI | ⭐ **其余目录都从它同步** |
| PulseMCP | 277K | **自动同步** | 人工审核，权威度高 |
| Smithery | 446K | 网页 / CLI | 支持一键安装 |
| mcp.so | 238K | 表单 | 按**真实调用量**排序 |
| mcpservers.org | 504K | 表单 | 自然搜索流量最强 |

→ **先发官方，其他四个自动来或各填一份 5 分钟的表单。**

---

## 二、前置条件（已全部就位）

| # | 条件 | 状态 |
|---|---|---|
| 1 | GitHub 公开仓库 | ✅ https://github.com/bruceonline2026/FeedWatch |
| 2 | 反向域名 namespace | ✅ `io.github.bruceonline2026/feedwatch` |
| 3 | `server.json` | ✅ 已创建，**7 项官方硬性要求全部通过** |
| 4 | 公网可达的 remote | ✅ `https://api.tiici.com/mcp` 实测 `tools/list` → 200 |
| 5 | description ≤ 100 字符 | ✅ 恰好 100（超出会被 API 422 拒绝） |
| 6 | 每个工具描述 ≥ 40 字符 | ✅ 151 / 80 / 142 |

---

## 三、提交步骤（在你 Mac 上跑，约 5 分钟）

### Step 1 · 安装发布 CLI

⚠️ **`mcp-publisher` 不发布到 npm** —— `npm install -g @modelcontextprotocol/registry-publisher`
会返回 `404 Not Found`（**已于 2026-10-15 实测踩坑**）。官方只提供预编译二进制。

**推荐：Homebrew**
```bash
brew install mcp-publisher
```

**或：官方预编译二进制**（自动识别系统与架构）
```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" \
  | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
```

**Windows**（PowerShell）
```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"
tar xf mcp-publisher.tar.gz mcp-publisher.exe; rm mcp-publisher.tar.gz
# 把 mcp-publisher.exe 放进 PATH
```

验证：
```bash
mcp-publisher --help
# 应列出：init / login / logout / publish / status / validate
```

### Step 2 · 先验证（**不要跳过**）

```bash
cd /Users/jiayongxu/360AI云盘同步版/LightWork/02实施/06MCP
mcp-publisher validate
```

`validate` 只校验不发布。**官方 schema 可能要求我们没填的字段**，
先验一遍能立刻知道缺什么，比 `publish` 失败再回头查快得多。

> ⚠️ **本项目是纯远程端点模式**，不需要发 npm 包、不需要 npm 账号。
> 官方原文：「If your MCP server is available only at a public remote endpoint,
> you can publish its metadata without a package.」
> 若 `validate` 提示 `packages` 字段有问题，**直接把 `server.json` 里的 `packages` 数组删掉**即可。

### Step 3 · 登录（走 GitHub 设备流）

```bash
mcp-publisher login github
```

浏览器打开授权页 → 用 **`bruceonline2026`** 账号确认。

> ⚠️ 必须是这个账号 —— 它是 `io.github.bruceonline2026/*` 命名空间的**所有者**，
> GitHub 授权才能拿到该 namespace 的发布权。用别的账号会授权失败。

### Step 4 · 发布

```bash
mcp-publisher publish
```

### Step 5 · 验证结果

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.bruceonline2026/feedwatch"
```

能看到返回结果即已上线。

---

## ⚠️ 本节踩过的坑（2026-10-15 实测）

| 坑 | 现象 | 正解 |
|---|---|---|
| **包名错误** | `npm install -g @modelcontextprotocol/registry-publisher` → `404 Not Found`，随后 `zsh: command not found: mcp-publisher` | 官方**不发 npm**，用 `brew install mcp-publisher` 或预编译二进制 |
| 误以为要发 npm 包 | 以为必须 `npm publish` 才能被收录 | **纯远程端点无需发包**，只需 `server.json` 里有 `remotes` |

> **教训**：凡是「`npm install -g <包>`」形式的指引，先用
> `curl -s https://registry.npmjs.org/<包名>/latest` 验证包是否存在，再让你执行。
> 官方工具常以「源码构建 + 预编译二进制」方式分发，不一定上 npm。

---

## 四、提交后：其余渠道

| 渠道 | 操作 | 耗时 |
|---|---|---|
| PulseMCP | **等 7 天自动同步** | 0 |
| Smithery | 打开 https://smithery.ai/new → 粘贴 `https://api.tiici.com/mcp` | 3 min |
| mcp.so | https://mcp.so/submit | 5 min |
| mcpservers.org | 提交表单 | 5 min |
| Glama | **无需提交**，自动抓取 GitHub；登录后认领 listing | 2 min |

---

## 五、⚠️ 提交前必须知道的一件事

**Smithery 在 2025-10 出现过路径遍历漏洞，暴露了 3,000+ 个托管服务器的 API Key。**

我们的 server 不托管在 Smithery（我们自建在 Vultr），**只做目录收录，不上传代码**，
所以暴露面为零。但建议你在客户端配置时**不要把主引导密钥填进去** ——
为每个用途单独签发一把 Key，泄露一把不影响其他。

---

## 六、发布后的检查清单

```bash
# 1. 官方注册表能搜到
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=feedwatch"

# 2. MCP 端点仍正常（注册表会周期性重扫）
curl -sI https://api.tiici.com/mcp

# 3. 三个工具都能正常返回
curl -X POST https://api.tiici.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $FEEDWATCH_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

⚠️ **Smithery / Glama 会周期性重扫端点。** 如果哪天发现收录页显示
「不可用」，先查是不是我们的服务挂了（`systemctl status feedwatch`），
而不是先怀疑收录问题。

---

## 七、已经准备好的提交文案

**server.json description（恰好 100 字符）：**
> Monitor RSS/Atom/JSON feeds; alerts on new items AND edits to existing ones, with field-level diffs.

**工具一句话卖点（用于各目录的描述栏）：**
> Detects edits to existing feed items with field-level diffs — most tools only report new items.

---

## 相关文件

| 文件 | 用途 |
|---|---|
| `server.json` | 官方注册表清单（7 项要求已全部通过）|
| `smithery.yaml` | Smithery 一键安装配置 |
| `README.en.md` | 英文说明，国际用户与 AI 引用源 |
| `deploy/setup-vultr-firewall.sh` | 云防火墙配置（收录后仍要保持三层防护）|

---

> ⚠️ 注册表与目录的政策会变。提交时以各站当日要求为准。
> 官方规范：https://github.com/modelcontextprotocol/registry


---

## 六、✅ 实际发布记录（2026-10-16 完成）

**结果**：`io.github.bruceonline2026/feedwatch` v0.1.0 **已在官方注册表上线**
（API 回读确认：https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.bruceonline2026/feedwatch）

### 本次踩到的两个坑

**坑 1：JWT 有效期很短，login 与 publish 必须连着做**

```
Error: 401 "token has invalid claims: token is expired"
```

登录后**约 1 小时内**必须完成 publish。分两次做（例如今天授权、明天发布）
就会像这样失败。**正确做法：两个命令在同一个终端连着跑。**

**坑 2：`mcp-publisher` 不发 npm，且我最初给错了包名**

`npm install -g @modelcontextprotocol/registry-publisher` → 404（该包不存在）
→ 正确：`brew install mcp-publisher` 或官方预编译二进制（本机Apple Silicon 无 brew，
装到 `~/.local/bin`）。

### 发现：注册表不显示 tools（不是问题）

发布后回读记录里没有 `tools` 字段。**实测对照组：其他远程服务器也一样没有**
（如 ac.inference.sh/mcp）→ 设计如此：客户端通过 `tools/list` 实时获取，
不依赖注册表的静态描述。

### 已补但未发布的改进

`server.json` 增加了 `remotes[].headers` 声明鉴权头：

```json
"headers": [{
  "name": "Authorization",
  "description": "Bearer token，即你的 FeedWatch API Key…",
  "isRequired": true,
  "isSecret": true
}]
```

**为什么重要**：没有它，用户从注册表看不到「需要API Key」。
**但实际影响有限** —— 实测未认证请求返回
`401 + WWW-Authenticate: Bearer realm="feedwatch"`，
标准客户端会据此提示用户填 token。

⚠️ **已发布版本的元数据不可修改**（`mcp-publisher status` 只支持
active/deprecated/deleted），所以这条改进**要下个版本才生效**。
当前 `server.json` 里的 headers 仅在下次publish 时提交。


---

## 七、⚠️ Smithery 实测：对「远程 + API Key 鉴权」不通（2026-10-16 记录）

**结论：不要在 Smithery 上花时间。** 我们试了 50 分钟、撞了 5 面墙。

### 撞过的墙（按时间顺序）

| # | 现象 | 根因 |
|---|---|---|
| 1 | 网页 Publish → Connection settings弹窗 | 填了 header 参数，**它不认**（弹窗格式 ≠ configSchema）|
| 2 | 日志：`No config schema provided` | 缺 `configSchema` → 「users will NOT be prompted for these values」|
| 3 | 给configSchema 后仍要 OAuth | `Server metadata discovered (OAuth required)` —— 即使识别了 schema 仍判定要 OAuth |
| 4 | 授权链接 `{"error":"not_found"}` | deploymentId 状态不一致，`--resume` 报 `400 not in AUTH_REQUIRED state` |
| 5 | 等 5 分钟后 | `WorkflowInternalError: Attempt failed due to internal workflow error` ← **它自己崩了** |

### 唯一推进的一步

`smithery mcp publish --config-schema` 确实让日志从
`No config schema provided` 变成 `Using user-provided config schema`，
但**随后仍然卡在OAuth**。

### 正确的命令（留档，供将来有 OAuth 实现时参考）

```bash
smithery mcp publish "https://api.tiici.com/mcp" \
  -n <namespace>/feedwatch \
  --config-schema '{"type":"object","properties":{"apikey":{
    "type":"string","title":"FeedWatch API Key",
    "x-from":{"header":"x-api-key"}}},"required":["apikey"]}'
```

- `x-from` 告诉Smithery「用户填的值从哪个 header 读」
- ⚠️ `authorization` 不能作为 `x-from`（Smithery OAuth 保留头），但可用 `x-to`
- schema 限制：**≤20 字段、≤1KB**，只支持扁平类型

### 什么情况下 Smithery 才可用

需要**完整 OAuth 实现**（授权端点 + token 签发）。
我们目前是 API Key 鉴权 → 不兼容。

**若将来要做**：约 2-3 小时，收益仅「目录列表好看一点」——
用户连上照样要自己填 Key，**不改变转化路径**。优先级低。

### 替代路径（更省事，已验证）

| 渠道 | 方式 | 耗时 |
|---|---|---|
| **官方注册表** | `mcp-publisher publish` | ✅ 已完成 |
| **Glama** | **自动收录**，只需 claim ownership +配 test profile | ✅ 已完成（30 分钟）|
| **PulseMCP** | 从官方注册表自动同步 | ⏳ 7 天 |

**Glama 的 test profile 关键点**：
- Header 名填 `X-API-Key`（大小写不敏感）
- 官方明确说它是「separate from personal connections」，
  只用于自动健康检查与工具发现，**不会展示给访客**
- 配好后 Status 从 🔴 Unhealthy → 🟢 Healthy

> 💡 **教训**：**自动收录的渠道优先**。Glama 从 GitHub 推送到可搜索，
> 零表单；Smithery 要走 OAuth 流程，投入产出比悬殊。
