# FeedWatch MCP — 部署配置与待办

> 生成时间：2026-10-12
> 状态：核心代码完成，本地 25 项测试全通过
> 部署目标：`https://api.tiici.com` → IIS(10.0) 反代 → `127.0.0.1:3001`

---

## 一、需要徐总操作的三件事

### ✅ 第一件：添加 DNS A 记录（api.tiici.com）

**必须先做这一步**，否则无法绑定 HTTPS。

| 字段 | 值 |
|---|---|
| 主机记录 | `api` |
| 记录类型 | **A** |
| 记录值 | **47.116.215.156** |
| TTL | 600（或默认） |

**说明**：实测 `tiici.com` 与 `www.tiici.com` 目前都解析到 `47.116.215.156`，`api.tiici.com` 也已解析到同一 IP（可能已有记录，请到 DNS 托管方确认是否有这条 A 记录）。

⚠️ **如果 `api.tiici.com` 已有记录指向该 IP，直接用即可，不需要新增。**

---

### ✅ 第二件：添加 DNS TXT 记录（MCP 注册表域名验证）

**密钥对已生成**（私钥存于 `keys/mcp.key`，权限 600，**请勿提交到 Git**）。

**请在 DNS 托管方添加以下 TXT 记录**：

| 字段 | 值 |
|---|---|
| 主机记录 | `_mcp-publisher`（如官方文档有其他要求以其为准） |
| 记录类型 | **TXT** |
| 记录值 | 见下方（**整段复制，勿改动**） |

```
v=MCPv1; k=ed25519; p=lmBOR3vnWAPPd6YrFxB1mEtfborBA1UrzP7eHyZWmlw
```

**目的**：让 MCP 注册表的命名空间是 `com.tiici/feedwatch`，而不是 `io.github.用户名/xxx`。

⚠️ **TXT 生效需要时间**（通常几分钟到数小时），添加后我会验证再发布。

**如果暂时不方便加 TXT** → 可先用 GitHub 身份验证拿 `io.github.用户名/xxx` 命名空间，**功能完全一样，只是名字不够正式**，上线稳定后再换。

---

### ✅ 第三件：IIS 配置（授权我做，或你自己操作）

**配置文件已备好**（见第二节），需要：

1. IIS 安装 **Application Request Routing（ARR）** + **URL Rewrite**
2. 新建应用程序池（建议名：`FeedWatchPool`）
3. 添加反向代理规则
4. 申请并绑定 `api.tiici.com` 的 HTTPS 证书

---

## 二、IIS 反向代理配置（需要安装 ARR）

### 2.1 一次性安装（管理员 PowerShell）

```powershell
# 安装 IIS 扩展（若已安装会跳过）
dism /online /add-capability /CapabilityName:IIS-WebServer-RequestFiltering
Install-WindowsFeature Web-WebSockets, Web-Http-Logging

# ARR 与 URL Rewrite（若服务器上还没有，需从微软官网下载离线安装包）
# ARR:https://www.iis.net/downloads/microsoft/application-request-routing
# URL Rewrite:https://www.iis.net/downloads/microsoft/url-rewrite
```

### 2.2 启用 ARR 服务器代理

```powershell
& "$env:windir\System32\inetsrv\appcmd.exe" set config -section:system.webServer/proxy -enabled:true -commit:apphost
```

### 2.3 反向代理规则（web.config 片段）

放到 `api.tiici.com` 站点的 `web.config`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <proxy>
        <forward wsd:for="https" to="http://127.0.0.1:3001" />
      </proxy>
      <rules>
        <rule name="FeedWatchProxy" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:3001/{R:1}" />
          <serverVariables>
            <!-- 透传 WebSocket 升级头 -->
            <set name="HTTP_X_FORWARDED_PROTO" value="https" />
            <set name="HTTP_X_FORWARDED_PORT"  value="443" />
          </serverVariables>
        </rule>
      </rules>
    </rewrite>
    <httpProtocol>
      <!-- ★ 关键：WebSocket 与长连接必须禁缓冲，否则 SSE/WS 会被 IIS 挂住 -->
      <customHeaders>
        <add name="X-Content-Type-Options" value="nosniff" />
      </customHeaders>
      <webSocketSettings />
    </httpProtocol>
    <security>
      <requestFiltering>
        <requestLimits maxAllowedContentLength="1048576" />
      </requestFiltering>
      <httpCustomHeaders>
        <remove name="X-Powered-By" />
      </httpCustomHeaders>
    </security>
  </system.webServer>
</configuration>
```

### 2.4 applicationHost.config 中的 WebSocket 设置

```powershell
appcmd.exe set config -section:system.webServer/webSocketSettings `
  /websocketKeepAliveInterval:"30" `
  /enableCompressionHistory:false `
  /commit:apphost
```

⚠️ **`websocketKeepAliveInterval` 必须设置**，否则 MCP 的长连接会被 IIS 判定为空闲后掐断。

### 2.5 Node 服务端环境变量

```
# 仅监听本机，⚠️ 绝不能改成 0.0.0.0
HOST=127.0.0.1
PORT=3001
PUBLIC_URL=https://api.tiici.com

# 引导密钥（必填，>=32 字符）
# ⚠️ 自 2026-10-17 起，API Key 的**哈希已落盘**，重启后仍然有效；
#    但引导密钥本身只从环境变量读取，**改这个值等于换一把新钥匙**，
#    旧的引导 Key 仍认（哈希在库里），新的也会被注入。
#    没有它重启后拿不到任何 API Key，服务 100% 不可用。
FEEDWATCH_BOOTSTRAP_KEY=<64位随机串>

# 客户数据存储路径（可选，默认 /opt/feedwatch/data/store.json）
# 权限自动设为 600（仅属主），目录 700
# FEEDWATCH_DB=/opt/feedwatch/data/store.json

# 设为 off 可退回纯内存（**会丢客户数据**，仅测试与应急使用）
# FEEDWATCH_PERSIST=off

# 跨域白名单
ALLOWED_ORIGINS=https://tiici.com,https://www.tiici.com

# 出网代理（仅当服务器抓不到境外源时才需要，见第五节）
#HTTPS_PROXY=http://user:pass@proxy.host:port
#HTTP_PROXY=http://user:pass@proxy.host:port
```

⚠️ **为什么必须 127.0.0.1**：改成 0.0.0.0 会让 3001 端口直接暴露公网，**绕过 IIS 的 TLS 终止、访问日志与 WAF**，是严重的安全隐患。

⚠️ **FEEDWATCH_BOOTSTRAP_KEY 是必填项**：API Key 存在内存里，重启即清空，而创建 key 的端点本身又要鉴权。没有这把引导密钥，服务重启后就彻底锁死。

---

## 三、服务端进程管理（Windows 计划任务）

> ⚠️ 目标服务器是 **Windows Server**，没有 pm2 / systemd。
> 下文第三节的 pm2 与 systemd 方案**不适用**，请用 `deploy/` 目录下的计划任务方案。

### Windows 计划任务（推荐，已备好脚本）

```cmd
REM 1. 上传代码到 C:\inetpub\FeedWatch 后，先编辑 run-node.cmd 填入真实引导密钥
REM 2. 管理员 cmd 执行：
cd C:\inetpub\FeedWatch\deploy
install-task.cmd

REM 3. 验证
status-task.cmd
REM    应看到 FeedWatchNode（运行中）+ FeedWatchWatchdog（每 5 分钟）
REM    netstat 中 3001 端口应只监听 127.0.0.1
```

脚本会创建两个计划任务：

| 任务 | 触发条件 | 作用 |
|---|---|---|
| `FeedWatchNode` | 开机自启 | 启动 Node 服务 |
| `FeedWatchWatchdog` | 每 5 分钟 | 健康检查失败时自动拉起（含崩溃/内存泄漏卡死） |

日志输出到 `C:\inetpub\FeedWatch\logs\stdout.log` 与 `stderr.log`。

**手动操作**：
```cmd
start-task.cmd     REM 启动
stop-task.cmd      REM 停止（注意看护任务会在 5 分钟内拉起）
status-task.cmd    REM 查状态 + 端口 + 最近日志
```

⚠️ **停止服务时必须先禁用看护任务**，否则会被立刻拉起：
```cmd
schtasks /change /tn "FeedWatchWatchdog" /disable
```

### 崩溃恢复验证（上线前必做）

```cmd
taskkill /F /IM node.exe
REM 等待 ≤5 分钟，确认服务自动恢复
curl http://127.0.0.1:3001/health
```

---

## 四、⚠️ 出网限制对产品价值的影响（上线前必读）

**目标服务器 47.116.215.156 出网只通国内，境外站点全部超时。**

本产品的核心价值是「替用户抓取任意 URL」。若服务器抓不到境外源，
**监控 GitHub release、国外新闻站 RSS 这类场景全部不可用** —— 也就是
产品最有差异化的使用场景被砍掉一半。

### 必须先做的事

在服务器上跑一次连通性实测：

```cmd
cd C:\inetpub\FeedWatch\deploy
connectivity-check.cmd
```

该脚本调用**项目自身的 safeFetch**（不是 curl —— curl 通不代表 Node 通），
返回退出码 0 才可继续上线。

### 三个方案

| 方案 | 做法 | 代价 |
|---|---|---|
| **1. 配出网代理**（推荐） | 在 `run-node.cmd` 加 `HTTPS_PROXY` / `HTTP_PROXY` | 代码已支持，**零改动**。HTTPS 走 CONNECT 隧道、HTTP 走绝对 URI，均已实测通过。⚠️ **但代理模式下 SSRF 防护有缺口，必须同时配置代理侧的出站网段拦截**，见下方警告 |
| **2. 只做国内源** | 承认能力边界，改产品文案 | GitHub release / 国外 RSS 不可用，价值显著收窄 |
| **3. 抓取与推送分离** | 境外 VPS 跑抓取器，把变更推给服务器 | 架构改动最大，但彻底解决出网问题 |

### ⚠️ 配代理前必读：代理会削弱 SSRF 防护

**直连时**，`safeFetch` 用 `lookup` 把连接钉在已校验的 IP 上，能防 DNS rebinding。
**走代理时**，两个代理分支都没有 `lookup`：

```js
// ssrf.js requestOnce()
if (!proxy)      options = { ..., lookup: 钉住 pinnedIp }          // 有防护
else if (isHttps) options = { ..., createConnection: openTunnel }   // 无 lookup
else              options = { host: proxy.host, path: url.href }    // 无 lookup
```

`openTunnel` 的 CONNECT 目标是 **`url.hostname`（域名）而非已校验的 IP**，
域名由**代理侧**再解析一次 —— 那次解析不受我们校验。

**实测后果**（恶意代理 + 真实公网域名 `http://example.com/feed.xml`）：

```
status     = 200
resolvedIp = 172.66.147.243      ← 我们校验过的公网 IP
body       = "<rss>...LEAKED-INTERNAL-DB..."   ← 恶意代理返回的内容，原样带回
```

内网内容会经 `check_feed` 的 diff **回显给提交 URL 的用户**。

> **这推翻「配代理不影响 SSRF 防护」的说法** —— 那个结论来自一个无效测试
> （用的是字面量 IP，`assertHostIsPublic` 走 `net.isIP` 分支根本不查 DNS，
> 无论有没有代理都会被拦，所以证不了代理路径）。
>
> 注意：**字面量私有 IP 仍会被正确拦截**，直连路径也无缺口。
> 该缺口只在「配了代理」且「攻击者能控制目标域名 DNS（或代理被攻陷）」时可达。

**因此：配代理时，必须在代理侧同时配置出站网段白名单** ——

> 代理必须禁止访问 `169.254.0.0/16`、`127.0.0.0/8`、`10.0.0.0/8`、
> `172.16.0.0/12`、`192.168.0.0/16`

把防线从「应用单点」变成「应用 + 网络出口」双层。
**这是当前唯一与部署直接相关的 SSRF 残余风险，见 `上线检查清单.md`。**

彻底修法（把已校验的 IP 交给代理）：**已于 2026-10-12 完成** ——
HTTPS 用 `CONNECT <pinnedIp>:443` + `Host: <原始域名>`（SNI 不变）；
HTTP 用绝对 URI 并把 host 替换为 `pinnedIp`。代理因此只能连我们批准过的 IP。

> **`NO_PROXY` / `no_proxy` 已实现**（curl 语义）：命中即强制直连。
> 支持逗号/空格分隔、`*`、子域前缀、显式端口、大小写不敏感、协议前缀写法。
> 显式传入的 `proxyUrl` 优先于 `NO_PROXY`（调用方点名要代理就尊重之）。
>
> ⚠️ **只影响代理选择，不影响 SSRF 校验** —— 走直连时仍经 `lookup` 钉住已校验 IP。

---

## 五、MCP 注册表发布步骤（等 TXT 加好后）

```bash
# 1. 安装
npm install -g @modelcontextprotocol/publisher

# 2. 初始化（在项目目录）
mcp-publisher init

# 3. 用域名登录（需先配好 TXT 记录）
mcp-publisher login dns --domain tiici.com --private-key ./keys/mcp.key

# 4. 发布
mcp-publisher publish

# ⚠️ 注意：已发布的版本不可编辑或删除，publish 前务必 review server.json
```

### server.json 模板

```json
{
  "name": "com.tiici/feedwatch",
  "description": "Monitor RSS/Atom/JSON feeds with field-level diffs on edits, not just new items",
  "version": "0.1.0",
  "repository": {
    "url": "https://github.com/<你的账号>/feedwatch",
    "source": "github"
  },
  "remotes": [
    {
      "type": "streamable-http",
      "url": "https://api.tiici.com/mcp"
    }
  ]
}
```

⚠️ **description 有 100 字符限制**，且 Agent 选型时只读这一行——**要写清楚"能做什么"，不要写类别名**。

当前代码返回的 name 是 `io.github.your-org/feedwatch`，**发布前需改成 `com.tiici/feedwatch` 与你的 GitHub 账号**。

---

## 六、后续发布清单（按优先级）

| 顺序 | 渠道 | 地址 | 备注 |
|---|---|---|---|
| 1 | **官方 MCP 注册表** | `registry.modelcontextprotocol.io` | 一处发布，聚合目录自动抓取 |
| 2 | Docker MCP Catalog | `docker/mcp-registry` | 提 PR，约 24h 生效 |
| 3 | Claude 目录 | 开发者门户 | 需 https URL |
| 4 | OpenAI 插件目录 | Plugin ZIP | ChatGPT / Codex 用户 |
| 5 | Smithery | `smithery.ai/new` | 免费，扫描工具给质量分 |
| 6 | mcpservers.org | 表单 | 免费排队约 2 周 |
| 7 | Glama | 需认领 | 只合并带 badge 的条目 |
| 8 | RapidAPI | 需另注册 | 唯一自带结算 |

---

## 七、测试结果（离线 85 项全绿＋ 真实源 28 项）

```bash
npm test              # 13 + 21 + 26 + 5 + 20 = 85 项（全离线）
npm run test:live    # 28 项真实源（需出网，结果依环境而变）
npm run connectivity # ★ 目标服务器出网自检 ← 上线前必跑
```

| 套件 | 项数 | 覆盖内容 |
|---|---|---|
| `selftest.js` | 13 | 三协议解析 / 字段级 diff / SSRF 网段判定 |
| `regression.js` | 21 | 锁死本次修复的缺陷 + 出站代理 + 已知限制 |
| `regression-functional.js` | 26 | 功能路径回归（含 RSS 1.0 / BOM / 实体解码） |
| `regression-scheduler.js` | 5 | 调度与并发 |
| `e2e.js` | 20 | HTTP 服务 / MCP 握手 / 鉴权 / 跨租户 |
| `livefeed-test.js` | 28 | **15 个真实源** + 10 项边界/并发（需出网） |

> ⚠️ **真实源测试依环境而变**，实测三档：
> 本地直连 28/28 · 本地走沙箱代理 25/28（429 限流 + 代理拒绝，均非代码缺陷） · 目标服务器待测。

### 真实源兼容性实测（QA 阶段新增）

15 个真实源全部通过解析与 diff 校验（正文可用率、id唯一性、哈希稳定性）：

| 类型 | 源 | 结果 |
|---|---|---|
| Atom | GitHub Releases（linux / nodejs） | ✓ 10 条，814KB |
| RSS | Hacker News / Ars Technica / NASA | ✓ |
| Atom | The Verge / Cloudflare Blog | ✓ |
| RSS | 人民网（100 条）/ 中新网 / 少数派 | ✓ 国内源 |
| RSS | GitHub Blog（1.18MB）/ WordPress | ✓ 大体积 |
| RSS | Ruby.info（高频更新） | ✓ |
| JSON Feed | jsonfeed.org 官方示例 | ✓ |
| 异常 | 已死域 / 非 Feed HTML 页 / SSRF 目标 | ✓ 均被正确拒绝 |

> ⚠️ 跑 live 测试前须清代理环境变量：`npm run test:live` 已内置处理。

---

## 八、开发过程中修掉的关键缺陷

### 缺陷一：MCP 工具调用静默失效（严重）

**现象**：`handleMcpRequest` 的 `tools/call` 分支返回 Promise，但函数本身是同步的。`JSON.stringify(Promise)` → `{}`，**所有工具调用返回空对象**。

**后果**：MCP 端点看似能用（initialize 和 tools/list 都正常），但**一调工具就废**。这个 bug 在测试里表现为"返回内容为空"，很容易被误判为测试写法问题。

**修复**：所有分支统一返回 Promise，并在调用处 `await`。

**教训**：**异步返回值必须全链路 await**，混用同步/异步返回是最隐蔽的 bug 之一。

### 缺陷二：富文本正文解析错误

**现象**：`<description>Hello <b>world</b></description>` 这类含子标签的内容，`fast-xml-parser` 返回对象而非字符串，原实现 `String(obj)` 得到 `"[object Object]"`。

**后果**：**所有含标签的 RSS 正文都解析为空** → 哈希全相同 → **永远检测不到内容变化**。

**修复**：新增 `nodeText()` 递归取值，并用空格拼接子节点（否则 `Hello <b>world</b>` 会变成 `Helloworld`）。

**教训**：**结构化解析必须处理"节点可能是对象"的情况**，这是所有 XML/HTML 解析库的共同陷阱。

### 缺陷三：所有抓取 100% 失败（P0，QA 阶段发现）

**现象**：`safeFetch` 的清理代码写成 `dispatcher.close?.()`。可选链保护的是 `.close` 这个属性，但 `dispatcher` 本身是 `undefined`，于是直接抛 `TypeError: Cannot read properties of undefined`。

**后果**：**100% 的抓取全部失败**。这个服务从未成功抓到过任何一个 feed —— 包括 GitHub Releases、人民网在内的一切源。且因为异常发生在所有 SSRF 校验通过之后，25 项原有测试全部无法暴露它（测试只覆盖了「被拒绝」的路径，没覆盖「成功」的路径）。

**修复**：改用 `node:http`/`node:https` 直接发请求，重写整个传输层。

**教训**：**安全校验的测试覆盖了「拒绝」不等于覆盖了「放行」**。必须有一条真实抓取的测试，否则整条主链路可以全线崩溃而测试全绿。

### 缺陷四：DNS rebinding 防护是空实现（安全 P0，QA 阶段发现）

**现象**：原代码注释声称用 undici Agent「锁定已校验的 IP 防 DNS rebinding」，但 `buildPinnedDispatcher()` 依赖的 `globalThis.__undici` **从未被赋值**，该函数恒返回 `undefined`。校验完 DNS 后仍把原始 hostname 交给 `fetch()`，由 `fetch` **独立再解析一次 DNS**。

**后果**：注释里的防护是**纸面上的**。攻击者控制 DNS 时，第一次解析返回公网 IP（通过校验），第二次解析返回 `169.254.169.254`（实际连接目标）—— 一个完整的 TOCTOU 绕过。

**修复**：用 `node:http` 的 `lookup` 选项把 TCP 连接钉在校验过的 IP 上，同时 Host 头与 TLS SNI 仍用原域名（虚拟主机/CDN 不受影响）。

**教训**：**安全注释不等于安全实现**。声称有防护的代码路径，必须用「恶意解析器 → 断言被拦截」这种方式反向测试。

### 缺陷五：GitHub Releases 解析必失败（P0，QA 阶段发现）

**现象**：`processEntities: true` 会套用 `maxTotalExpansions: 1000` 的默认值。这本意是防「十亿 laughs」DoS，但它把 `&#39;` `&quot;` `&#x27;` 这类字符引用也计入预算。

**后果**：nodejs/node 的 releases Atom 有 3300 个字符引用，**直接解析失败**。GitHub Release 监控是核心场景，整个不可用。

**修复**：改为对象配置放宽总量上限，但**保留真正的 DoS 防线**（`maxExpansionDepth: 4`）。

**顺带查明**：fast-xml-parser 的 `DocTypeReader` 只注册「值中不含 `&`」的实体，所以嵌套实体（十亿 laughs）**结构性无效** —— 已用 1880 字节、理论膨胀 1e13 的 payload 验证未被膨胀。

**教训**：**安全限流值必须区分「攻击模式」与「正常模式」**。实测发现 `&amp;` 不计数而 `&#39;` 计数，说明这个计数器统计的不是同一类东西。

### 缺陷六：截断的 feed 污染快照 → 误报风暴（P1，QA 阶段发现）

**现象**：响应体超过 10MB 上限会被静默截断，`checkOnce` 却把截断后的残缺结果当成正常快照保存。

**后果**：上次抓到完整 50 条、本次只抓到前 10 条 → 本轮误报 **40 条「删除」**；下轮恢复正常 → 同一批又误报 **40 条「新增」**。用户收到 80 条垃圾通知，且监控点被污染到无法自愈。

**修复**：`checkOnce` 检测 `res.truncated` 时抛错跳过本轮，不保存残缺快照。

**教训**：**「部分成功」比「完全失败」更危险**，因为它会静默污染持久状态。

---

## 九、代码结构

```
06MCP/
├── package.json
├── src/
│   ├── server.jsHTTP 服务入口（REST + MCP），绑定 127.0.0.1
│   ├── service.js         核心服务：调度、抓取、比对、推送
│   ├── parser/feeds.js    三协议解析（RSS 2.0 / Atom 1.0 / JSON Feed）
│   ├── diff/engine.js     ★ 哈希粗筛 + 字段级 diff（核心差异化）
│   ├── notify/deliver.js  HMAC 签名 Webhook + Slack/Discord + 重试
│   ├── security/ssrf.js   SSRF 防护 + DNS 锁定 + 出站代理（P0）
│   └── mcp/endpoint.js    MCP Streamable HTTP 端点
├── scripts/
│   ├── selftest.js              单元自测（13 项）
│   ├── regression.js            缺陷回归 + 出站代理（19 项）
│   ├── regression-functional.js 功能回归（23 项）
│   ├── regression-scheduler.js  调度回归（5 项）
│   ├── e2e.js                   端到端测试（20 项）
│   └── livefeed-test.js         ★ 真实源兼容性（28 项，15 个真实 feed）
├── deploy/
│   ├── install-task.cmd         Windows 计划任务安装
│   ├── run-node.cmd             ★ 启动包装（填引导密钥 / 代理）
│   ├── watchdog.cmd             崩溃自动拉起
│   ├── connectivity-check.cmd   ★ 上线前出网自检
│   └── connectivity-probe.mjs   用 safeFetch 实测境内外源
└── docs/
    ├── 上线检查清单.md    ★ 三阶段 checklist
    └── 部署配置与待办.md
```

---

## 十、尚未实现（MVP 克制清单内）

| 项目 | 说明 |
|---|---|
| ~~数据库持久化~~ | **已完成（2026-10-17）**：监控点 / 快照基线 / API Key 哈希落盘到 `data/store.json`，权限 600。重启、升级、补丁不再丢客户数据。详见 `docs/数据存储边界.md` |
| 快照体积 | 每个监控点存一份完整快照（实测单份约 150KB）。几百个监控点约 50MB；**上千个需评估是否压缩或分层存储** |
| 网页监控（CSS 选择器） | 阶段三功能，MVP 只做三种 Feed |
| 变更历史查询 | 阶段二功能 |
| 邮件通道 | 代码留了接口，实际投递未接 |
| 免费层配额限制 | 服务层未实现，运营时需加 |

**这些是刻意砍掉的，不影响验证「有人愿意付钱」这个目标。**

---

## 十一、下一步

**等你三件事**：① 添加 api.tiici.com 的 A 记录（若尚未存在）② 授权 IIS 配置或加 TXT 记录 ③ 确认服务器登录方式

**之后我会做**：部署上线 → curl 验证 → 生成 MCP 注册表发布物料 → 提交各渠道