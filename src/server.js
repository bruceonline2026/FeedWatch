/**
 * HTTP 服务器：REST API + MCP 端点
 *
 * ⚠️ 绑定 127.0.0.1，不监听 0.0.0.0 —— 避免端口直接暴露公网绕过 IIS 的 TLS 与日志
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { MemoryStore, MonitorService, checkOnce, INTERVALS } from './service.js';
import { handleMcpRequest, serverManifest } from './mcp/endpoint.js';
import { mcpInfoPage } from './mcp/info-page.js';
import { getKeyPage, EMAIL_RE } from './mcp/get-key-page.js';
import { track, summarize } from './telemetry.js';
import { PersistentStore } from './persistence.js';
import { adminPage, adminEnabled, sessionValid, safeEqualAdmin, newAdminSession, cookieHeader, monitorRow } from './admin/page.js';
import { isPrivateAddress } from './security/ssrf.js';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3001);
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'https://api.tiici.com';

/**
 * 付款跳转配置（解决 Payoneer 收款链接「单次使用」的限制）
 *
 * ── 为什么需要这个 ──
 * Payoneer 收款链接**每条只能用一次**（官方原文：single-use, tied to one
 * buyer and one transaction, once paid it can't be reused）。所以直接把
 * 链接写进落地页，会出现：
 *   收第一笔钱 → 链接作废 → 落地页按钮指向死链
 *   → 任何新客户点「Get Pro access」都看到 "That payment link was already paid"
 * 而**死链与活链的 HTTP 响应完全相同**（都是 302 到 app.payoneer.com），
 * 程序无法自动区分，只能靠浏览器渲染后的文案 —— 也就是说**无法自动告警**。
 *
 * ── 做法：链接池 ──
 * 落地页按钮指向 `${PUBLIC_URL}/pay`（**永不改变**），由本端点读取
 * 服务器 pay-link.json 里的**链接数组**并 302 跳到第一条。
 *
 * 为什么不只存一条：验证期 0-5 个客户，**连续来两个客户就会撞链**。
 * 一次备 3 条，就能「一个被用过 → 手动把下一条标记为 current」，
 * 不必每次都现建链接（建一次要填 5 个字段，还容易触发符号黑名单）。
 *
 * 用完一条 → 只改服务器上那一个文件 → 落地页/README/推文都不用动。
 *
 * ── 安全 ──
 * 目标 URL 只允许 payoneer.com 域，且强制 https —— 防止配置文件被改成
 * 任意地址后把本站变成开放重定向器。
 */
const PAY_LINK_FILE = process.env.PAY_LINK_FILE ?? '/opt/feedwatch/pay-link.json';
const ALLOWED_PAY_HOSTS = new Set(['link.payoneer.com', 'payoneer.com', 'www.payoneer.com']);

/** 只接受白名单内的 https Payoneer 链接，否则返回 null */
function safePayUrl(raw) {
  const url = String(raw ?? '').trim();
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null; // 非法 URL
  }
  if (u.protocol !== 'https:') return null;
  if (!ALLOWED_PAY_HOSTS.has(u.hostname)) return null;
  return url;
}

/**
 * 读取链接池，返回 { current, standby[] }。
 *
 * 兼容两种格式：
 *   新：{ "current": "https://...", "standby": ["https://...", ...] }
 *   旧：{ "url": "https://..." }   ← 10-17 之前的格式，避免配置丢失导致无链可用
 */
function payLinkPool() {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(PAY_LINK_FILE, 'utf8')) ?? {};
  } catch {
    return { current: null, standby: [] };
  }

  const current = safePayUrl(cfg.current ?? cfg.url);
  const rawList = Array.isArray(cfg.standby) ? cfg.standby : [];
  const standby = rawList.map(safePayUrl).filter(Boolean);
  return { current, standby };
}

function currentPayLink() {
  return payLinkPool().current;
}

/**
 * 单账号监控点上限（与 /v1/usage 声明的 free 档位保持一致）。
 *
 * ⚠️ 免费层刻意设得很低（默认 5）：配额存在的意义是让用户「用着用着撞墙」，
 * 撞到墙才会看到付费入口。上限太高 = 永远撞不到 = 转化路径断掉。
 * 付费档位上线前，这里靠环境变量切换，不改代码。
 */
const MAX_MONITORS = Number(process.env.MAX_MONITORS ?? 5);

/**
 * 免费层允许的检查间隔，以及其中最短的一个。
 * 用于 /v1/usage 如实申报配额，避免返回硬编码的假数字。
 */
const FREE_INTERVALS = (process.env.FREE_INTERVALS ?? '21600')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
const MIN_INTERVAL = Math.min(...FREE_INTERVALS);

/** 监控点创建速率限制：窗口 60s 内最多 10 次 */
const CREATE_WINDOW_MS = Number(process.env.CREATE_WINDOW_MS ?? 60_000);
const CREATE_MAX = Number(process.env.CREATE_MAX ?? 10);

/**
 * API Key 签发限流（2026-07-15 补，此前该端点**完全无限流**）。
 *
 * 为什么需要两层：
 * · 滑动窗口（KEY_ISSUE_MAX / 分钟）防单账号被脚本批量刷
 * · 日配额（KEY_ISSUE_DAILY_MAX）防跨天持续累积 —— 窗口短到拦不住
 *
 * 为什么上限设这么低：配额是 per-key 的，总配额 = MAX_MONITORS × key 数。
 * key 无上限 = 内存监控点、定时器、出网流量全部无上限放大。
 * 业务口径是「每客户一把 Key，泄露只影响单个客户」，5 把足够内部运营使用。
 */
const KEY_ISSUE_WINDOW_MS = Number(process.env.KEY_ISSUE_WINDOW_MS ?? 60_000);
const KEY_ISSUE_MAX = Number(process.env.KEY_ISSUE_MAX ?? 3);
const KEY_ISSUE_DAY_MS = 24 * 3600 * 1000;
const KEY_ISSUE_DAILY_MAX = Number(process.env.KEY_ISSUE_DAILY_MAX ?? 20);

/**
 * 自助取 Key（GET/POST /get-key）的三层防护阈值。
 *
 * ⚠️ 这是**公开**的 Key 签发端点，没有引导密钥也能调，
 * 所以这三层是「防无限 Key 机器」的唯一屏障，任何一层都不能省。
 *
 * 为什么按 IP 限流是主防线：邮箱可以随便填，用邮箱当限流键等于没限。
 * IP 才是真实的资源成本单位。
 */
const GETKEY_IP_WINDOW_MS = Number(process.env.GETKEY_IP_WINDOW_MS ?? 3600_000);
const GETKEY_IP_MAX = Number(process.env.GETKEY_IP_MAX ?? 5);       // 同一 IP 每小时
const GETKEY_DAY_WINDOW_MS = 24 * 3600 * 1000;
const GETKEY_DAILY_MAX = Number(process.env.GETKEY_DAILY_MAX ?? 60); // 全站每天

/**
 * 把抓取异常映射成粗分类 —— 只用于埋点与文案，绝不携带 URL 或响应内容。
 *
 * 为什么要分类而不是直接用 message：message 里可能含上游域名，
 * 而 telemetry 的边界是「不记客户数据」。
 */
function probeReason(e) {
  const code = e?.code;
  if (typeof code === 'string' && ALLOWED_REASONS_FOR_PROBE.has(code)) return code;
  const msg = String(e?.message ?? '');
  if (/私有|保留地址|已拒绝/.test(msg)) return 'blocked';
  if (/RSS|RDF|Atom|feed 结构|XML/i.test(msg)) return 'not_feed';
  if (/截断|体积上限/.test(msg)) return 'too_large';
  if (/HTTP\s+\d{3}/.test(msg)) return 'http_error';
  if (/超时|timeout|ETIMEDOUT/i.test(msg)) return 'timeout';
  if (/DNS|解析失败|ENOTFOUND/i.test(msg)) return 'dns_fail';
  if (/url|URL|协议|protocol|仅支持 http/i.test(msg)) return 'invalid_url';
  return 'unknown';
}

/** 与 telemetry 的 ALLOWED_REASONS 对齐，避免埋点被丢弃 */
const ALLOWED_REASONS_FOR_PROBE = new Set([
  'not_feed', 'http_error', 'timeout', 'too_large', 'blocked',
  'invalid_url', 'dns_fail', 'unknown',
]);

/**
 * 每类失败对应的**下一步指引**。
 *
 * ⚠️ 为什么单独一张表：原来的错误信息只说「是什么错了」
 *   （如「不是有效的 RSS/RDF 结构」），用户不知道该做什么 ——
 *   这是 2026-10-17 真实用户试用时最大的挫败点。
 *   错误信息要回答的是「我接下来该怎么办」，不是「你错在哪」。
 */
const PROBE_HINTS = {
  not_feed: '这个地址看起来不是 RSS/Atom/JSON Feed。若它是普通网页，请找它的 feed 地址（试试 /feed、/rss.xml、/atom.xml）；若它确实有 feed，请把该 feed 的完整 URL 发给我们。',
  http_error: '该地址返回了错误状态。若是普通网页，请改用它的 RSS/Atom 地址；若是临时故障，稍后重试即可。',
  timeout: '抓取超时。该站点可能响应很慢或有区域限制，我们目前不支持自定义抓取超时。',
  too_large: 'feed 超过 10 MB 上限，我们不监控这么大的文件。',
  blocked: '我们拒绝抓取内网或云元数据地址（安全策略）。',
  dns_fail: '域名解析失败。请确认地址拼写正确、且该域名公网可访问。',
  invalid_url: '地址格式不对，需以 http:// 或 https:// 开头。',
  unknown: '请确认该地址是一个可公开访问的 RSS / Atom / JSON Feed。',
};

/**
 * 允许跨域访问的来源白名单。
 *
 * 上线前审计修复：原先无条件返回 `access-control-allow-origin: *`，
 * 意味着任意第三方网站都能让受害者浏览器读 api.tiici.com 的跨域响应。
 * 现在只放行显式配置的来源；未配置时不同源但同站调用仍可用
 * （MCP 客户端多为服务端到服务端，不依赖浏览器 CORS）。
 */
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? 'https://tiici.com,https://www.tiici.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

/**
 * 持久化：监控点 / 快照基线 / API Key
 *
 * ⚠️ 之前全部只在内存里，`systemctl restart feedwatch` 之后：
 *   · 客户的监控点消失 —— 告警静默停止，客户不知道
 *   · **快照基线丢失 → 重启后首次检查把所有条目当「新增」，全是假告警**
 *   · 客户 API Key 失效 → 必须重新配置
 *
 * 「客户少就可以不存」是不成立的：任何一次升级、补丁、重启都会清空，
 * 而监控服务的价值恰恰是**长期稳定地不漏报**。
 *
 * 落盘用零依赖的 JSON 文件（取舍见 src/persistence.js）：
 * 生产 Node v22.23.3 的 `node:sqlite` 仍是实验性模块，不能作依赖。
 */
const DATA_FILE = process.env.FEEDWATCH_DB ?? '/opt/feedwatch/data/store.json';
const persistence = process.env.FEEDWATCH_PERSIST === 'off'
  ? null
  : new PersistentStore(DATA_FILE);

export const store = new MemoryStore({ persistence });

if (persistence) {
  const restored = store.restore(persistence.load());
  console.log(
    `[feedwatch] 已从 ${DATA_FILE} 恢复：`
    + `${restored.monitors} 个监控点 · ${restored.snapshots} 份快照 · ${restored.apikeys} 把 Key`,
  );
}

const service = new MonitorService(store, { maxMonitors: MAX_MONITORS });

/**
 * 引导密钥：此前 createApiKey 只能在需要鉴权的 /v1/apikeys 里调用，
 * 而该端点本身又需要已有 key —— 鸡生蛋死锁，首次部署根本拿不到任何凭据。
 * 现在支持用环境变量注入一把启动密钥，仅从环境读取，不落盘、不打印明文。
 */
const BOOTSTRAP_KEY = process.env.FEEDWATCH_BOOTSTRAP_KEY;
let bootstrapId = null; // 引导密钥的记录 id —— 自助签发的 Key 挂在它下面
if (BOOTSTRAP_KEY) {
  if (BOOTSTRAP_KEY.length < 32) {
    console.error('[feedwatch] FEEDWATCH_BOOTSTRAP_KEY 过短（<32 字符），已拒绝启动');
    process.exit(1);
  }
  const seeded = store.seedApiKey(BOOTSTRAP_KEY, 'bootstrap');
  // ⚠️ seedApiKey 在「该密钥已存在」时返回 null —— 而引导密钥由环境变量注入，
  //   进程重启后内存里本就没有它，所以正常情况下会返回 { id }。
  //   但一旦返回 null，bootstrapId 会是 null，自助签发的 Key 就挂不到根节点，
  //   限流分桶会退化。兜底：直接按明文反查记录拿 id。
  bootstrapId = seeded?.id ?? store.findApiKey(BOOTSTRAP_KEY)?.id ?? null;
  if (!bootstrapId) {
    console.error('[feedwatch] 无法确定引导密钥 id —— 自助取 Key 签发的 Key 将挂不到根节点');
  }
  console.log('[feedwatch] 已载入引导密钥（来自 FEEDWATCH_BOOTSTRAP_KEY）');
}
service.startAll();

/**
 * 退出前同步刷盘。
 *
 * ⚠️ 平时靠 markDirty 的 setImmediate 落盘，但**退出路径必须再兜一次**：
 *   setImmediate 队列可能还没跑完进程就结束了，最后一批变更就丢了。
 *   systemd 的 restart/stop 走的是 SIGTERM，所以这个钩子是必需的。
 *
 * 两次信号都注册：SIGTERM（正常停止）/ SIGINT（Ctrl+C、手动 kill）。
 */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    const ok = store.persistNow();
    console.log(`[feedwatch] 收到 ${sig}，已${ok ? '刷盘' : '尝试刷盘（见上方告警）'}，退出`);
    process.exit(0);
  });
}
// 未捕获异常也先刷盘：崩之前能存住多少是多少
process.on('uncaughtException', (e) => {
  console.error('[feedwatch] 未捕获异常：', e);
  try { store.persistNow(); } catch { /* 刷盘失败不掩盖原始错误 */ }
  process.exit(1);
});

const startedAt = new Date().toISOString();
const version = '0.1.0';

// --- 统一错误格式（第一天就定，避免以后统一要改全部文档） ---
const err = (res, status, message, extra = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: message, ...extra }));
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** 请求体超限 —— 用独立错误类型，便于回 413 而不是笼统的 500 */
class BodyTooLarge extends Error {
  constructor() {
    super('请求体过大');
    this.name = 'BodyTooLarge';
    this.statusCode = 413;
  }
}

async function readBody(req, limit = 1024 * 1024) {
  // 客户端声明的长度已超限时立即拒绝，不必先收完再判断
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    // 排空剩余请求体，避免直接响应导致连接被 RST（keep-alive 下会连带弄坏后续请求）
    req.resume();
    throw new BodyTooLarge();
  }

  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) {
      req.resume();
      throw new BodyTooLarge();
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function authenticate(req) {
  // MCP 客户端通常用 Authorization: Bearer，REST 用 x-api-key，两者都接受
  const bearer = req.headers.authorization;
  if (typeof bearer === 'string' && bearer.toLowerCase().startsWith('bearer ')) {
    const found = store.findApiKey(bearer.slice(7).trim());
    if (found) return found;
  }
  const key = req.headers['x-api-key'];
  if (!key) return null;
  return store.findApiKey(String(key));
}

/**
 * 滑动窗口限流器。
 *
 * 上线前审计发现：/mcp 匿名可调用，实测 500 次匿名 create_monitor 耗时 162ms
 * 且全部成功（3086 req/s），每个监控点还会挂一个常驻定时器。没有限流等于
 * 把服务交给攻击者控制内存与出网流量。
 */
const buckets = new Map();

function rateLimit(key, { windowMs, max }) {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    // 只保留窗口内的记录，避免 Map 无限增长
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

/**
 * 只读当前窗口内的命中数，不消耗配额。
 * 用于在响应里如实告知「今天还剩几把」—— 不做这个的话，
 * 调用方只能靠反复试错来推断剩余量（试到 429 才知道用完了）。
 */
function rateLimitPeek(key) {
  const now = Date.now();
  return (buckets.get(key) ?? []).filter((t) => now - t < KEY_ISSUE_DAY_MS).length;
}

/**
 * 定期清理过期的限流桶，防止 key 空间被无限撑大（内存泄漏）。
 *
 * ⚠️ 清理阈值必须取**所有窗口的最大值**，不能用 CREATE_WINDOW_MS——
 * 日配额桶的寿命是 24 小时，若按 60 秒清理，配额会在一天内被清空，
 * 攻击者只要等过清理周期就能绕过上限（限流形同虚设）。
 */
const SWEEP_MS = KEY_ISSUE_DAY_MS;
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, hits] of buckets) {
    const live = hits.filter((t) => now - t < SWEEP_MS);
    if (live.length === 0) buckets.delete(k);
    else buckets.set(k, live);
  }
}, Math.max(SWEEP_MS, CREATE_WINDOW_MS));
sweep.unref?.();

/** 取客户端标识，用于限流分桶 */
function clientId(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // 安全响应头（IIS 层也配了一份，但 Node 层不能依赖上游一定配对）
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
  // 本服务主要返回 JSON，默认禁止浏览器对任何响应做 MIME 嗅探
  //
  // ⚠️ **但 HTML 页面需要 style-src 'unsafe-inline'**（2026-10-17 修）：
  //   `default-src 'none'` 会把 `<style>` 内联样式一起禁掉 ——
  //   结果是 `/admin` 后台**拿到完整 HTML 与 CSS，浏览器却拒绝应用任何样式**，
  //   页面渲染成一堆无格式的纯文本（徐总截图发现）。
  //
  //   注意这不是「放开 CSP」，而是**按响应类型给最小必要权限**：
  //   · style-src 只放 unsafe-inline（允许内联样式），仍然**禁止外部脚本**
  //   · script-src 'none' —— 页面里**永远不会有脚本**，保持禁止
  //   · img-src 只放 data: —— 允许内联图标，仍然**禁止任何外部资源请求**
  //   · form-action 'self' —— 登录表单只能 POST 回自己
  //
  // ⚠️ **必须按「这个端点会返回 HTML」判断，不能读 res.getHeader('content-type')** ——
  //   content-type 是在处理器里 writeHead 时才设的，而这里在它之前执行，
  //   读到的永远是空 → 条件恒为 false → 走了严格分支 → 样式又被禁。
  //   这就是「代码看起来对、实际没生效」的典型。
  const HTML_PATHS = new Set(['/admin', '/mcp', '/get-key']);
  res.setHeader(
    'content-security-policy',
    HTML_PATHS.has(path)
      ? [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "img-src data:",
        "script-src 'none'",
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; ')
      : "default-src 'none'; frame-ancestors 'none'",
  );

  // CORS：允许 MCP 客户端跨域调用。
  // 上线前审计修复：原先对所有响应（含鉴权区）返回 `*`，任何网站都能
  // 用受害者浏览器读取 api.tiici.com 的跨域响应。改为按来源白名单。
  const origin = req.headers.origin;
  if (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
  }
  res.setHeader('access-control-allow-headers', 'content-type, x-api-key, authorization, mcp-session-id, mcp-protocol-version');
  res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('access-control-max-age', '600');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // ---------- 无需鉴权 ----------
    if (path === '/health') {
      return json(res, 200, {
        status: 'ok', version, started_at: startedAt,
        uptime_sec: Math.floor(process.uptime()),
        monitors: store.listMonitors().length,
      });
    }

    // ---------- 后台管理页 ----------
    //
    // ⚠️ 放在鉴权区之前是**刻意的**：它有自己的口令+session 鉴权，
    //    而浏览器打开页面时不会带 x-api-key 头，header 鉴权在这里无效。
    //
    // ⚠️ **fail closed**：没配 ADMIN_PASSWORD 时直接 404 ——
    //    绝不能出现「没配密码 = 等于不鉴权」。
    if (path === '/admin') {
      if (!adminEnabled()) {
        return err(res, 404, '无此端点：' + req.method + ' ' + path);
      }
      const html = (status, body, headers = {}) => {
        res.writeHead(status, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex, nofollow',
          ...headers,
        });
        res.end(body);
      };

      if (req.method === 'GET') {
        if (!sessionValid(req)) return html(200, adminPage({ stats: null }));
        return html(200, adminPage({
          stats: summarize(),
          extra: {
            payLinks: (() => { const p = payLinkPool(); return {
              has_current: Boolean(p.current), standby_count: p.standby.length,
              needs_new_link: !p.current || p.standby.length === 0 }; })(),
            liveMonitors: {
              monitors: store.listMonitors().length,
              uptimeDays: Math.floor(process.uptime() / 86400),
            },
            /**
             * 监控点排障明细（2026-10-17，徐总「不知道用户监控 Url 和结果，
             * 怎么验证监控的情况是否正确」）。
             *
             * ⚠️ 必须经`monitorRow()` 投影后再传给 page.js —— 它是**白名单**：
             *   只有显式列出的字段才可能进HTML。
             *   直接传 `store.listMonitors()` 的原始对象就等于把
             *   channels（可能含历史 __secret）等字段一起交出去，
             *   靠 page.js 「记得别渲染」来防 —— 那正是这次要改掉的模式。
             *
             * 数据来源是**内存 Map**（`listMonitors()` 读 `this.monitors`），
             * 不读 store.json —— 所以文件权限 600 与本页无关，
             * 同进程同uid 天然可读。
             */
            monitors: store.listMonitors().map((m) => monitorRow(m)),
          },
        }));
      }

      if (req.method === 'POST') {
        const raw = await readBody(req, 4096);
        let pw = '';
        try {
          pw = String(new URLSearchParams(raw).get('password') ?? '');
        } catch { /* 非表单 */ }
        if (!safeEqualAdmin(pw, process.env.ADMIN_PASSWORD ?? '')) {
          return html(401, adminPage({ stats: null, error: '口令不对' }));
        }
        return html(302, '', { location: '/admin', 'set-cookie': cookieHeader(newAdminSession()) });
      }
    }

    if (path === '/.well-known/mcp.json' || path === '/mcp.json') {
      return json(res, 200, serverManifest(`${PUBLIC_URL}/mcp`, 'https://github.com/your-org/feedwatch'));
    }

    // ---------- 自助取 Key ----------
    //
    // ⚠️ 这是**公开的 Key 签发端点**（徐总 2026-10-17 要求：
    // 「Start free」原本跳到三步接入说明，用户拿不到 Key 就走了）。
    //
    // 因此三层防护缺一不可 —— 少任何一层，这个端点就是一台
    // 「无限 Key 机器」：
    //   ① 邮箱格式校验        挡掉明显的脚本
    //   ② 按 IP 限流 5 把/小时  挡单 IP 批量
    //   ③ 全局日上限 60 把/天    挡换 IP / 分布式
    //
    // 为什么用 IP 而不是邮箱做主限流键：邮箱可以随便填，
    // 用它当键等于没有限制。IP 才是真实的成本单位。
    if (path === '/get-key') {
      if (req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        return res.end(getKeyPage({
          remaining: Math.max(0, GETKEY_DAILY_MAX - rateLimitPeek('getkey-day')),
        }));
      }
      if (req.method === 'POST') {
        const ip = req.socket.remoteAddress ?? 'unknown';
        const ipKey = `getkey-ip:${ip}`;

        // ② IP 小时限流
        if (!rateLimit(ipKey, { windowMs: GETKEY_IP_WINDOW_MS, max: GETKEY_IP_MAX })) {
          res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(getKeyPage({
            email: null,
            error: `Too many keys from this network. Try again in about ${Math.round(GETKEY_IP_WINDOW_MS / 60000)} minutes, or email bruceonline2018@gmail.com.`,
          }));
        }

        // ③ 全局日上限（check-then-act：先占位再签发，避免并发穿透）
        if (!rateLimit('getkey-day', { windowMs: GETKEY_DAY_WINDOW_MS, max: GETKEY_DAILY_MAX })) {
          res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(getKeyPage({
            email: null,
            error: 'Daily self-service limit reached. Email bruceonline2018@gmail.com and we will issue a key manually within 1 business day.',
          }));
        }

        const body = await readBody(req);

        // ⚠️ **必须同时支持两种提交格式**（2026-10-17 修）
        //
        // 页面里放的是标准 HTML <form>，浏览器提交的是
        // `application/x-www-form-urlencoded`，**不是 JSON**。
        // 原实现只 `JSON.parse(body)` → 浏览器真实提交一律 parse 失败
        // → 走到「邮箱为空」→ 400。
        //
        // 这就是「只声明不强制」：页面声明了「填邮箱拿 Key」，
        // 但后端只实现了 JSON 那条路，**没人用真浏览器试过**，
        // 所以测试全绿（测试用的都是 fetch + JSON）。
        //
        // 现在两种都认，且 e2e 有断言逼住「表单提交也必须能签发出 Key」。
        let email = '';
        const ctype = String(req.headers['content-type'] ?? '');
        if (ctype.includes('application/json')) {
          try {
            email = String(JSON.parse(body || '{}').email ?? '').trim();
          } catch { /* 非 JSON，按空处理 */ }
        } else {
          // 浏览器表单：email=foo%40bar.com
          try {
            email = String(new URLSearchParams(body || '').get('email') ?? '').trim();
          } catch { /* 非法编码，按空处理 */ }
        }
        email = email.slice(0, 120);

        // ① 邮箱格式校验
        if (!EMAIL_RE.test(email)) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(getKeyPage({
            email,
            error: 'That does not look like a valid email address. Example: you@example.com',
          }));
        }

        // 签发：标记 parentId=bootstrap 根、isBootstrap=false
        // → 与内部引导密钥签发的 Key 同源，但**不能签发新 Key**（D8 门控仍生效）
        const label = `selfservice:${email.split('@')[1] ?? 'unknown'}`;
        const k = store.createApiKey(label, { parentId: bootstrapId, isBootstrap: false });
        // ⚠️ **只记 key.id，不记邮箱、不记域名**
        //   label 里含邮箱域名，但那是内存里的 Key 记录，不进事件日志。
        track('key_issued', { keyId: k.id, source: 'selfservice' });

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(getKeyPage({
          email,
          issued: { key: k.raw, label },
          remaining: Math.max(0, GETKEY_DAILY_MAX - rateLimitPeek('getkey-day')),
        }));
      }
    }

    // ---------- 付款跳转 ----------
    // 放在鉴权区之前：这是公开的付费入口，任何访客都应能点到。
    // 链接内容来自服务器配置文件，不含任何凭据。
    // ---------- 数据存储边界（公开，无需鉴权）----------
    //
    // ⚠️ 放在鉴权区之前是**刻意的**：这是**对外承诺**，任何访客（含未注册客户）
    //   都有权知道自己给了我们的数据存在哪里。以前这个事实散落在六处独立文本里，
    //   各自独立过期 —— 2026-10-17 加持久化后六处**全部**变成错误陈述。
    //   收敛到这里 + e2e 断言它与实际落盘字段一致，才不会再静默漂移。
    /**
     * ★ GET /v1/data-handling —— 数据存储边界的**唯一真源**（2026-10-17）
     *
     * ── 为什么要这个端点 ──
     * 此前「客户数据存在哪里」这一事实散落在**六处**独立文本里
     * （隐私政策中/英、落地页中/英、退款政策中/英），各自会独立过期。
     * 2026-10-17 加持久化功能后，六处**全部**变成了错误陈述 ——
     * 没有任何一处会因代码变化而自动报警。
     *
     * 做法：把边界收敛成一份**机器可读**的定义放在这里，
     * 由e2e 测试断言「这个列表」与「`MemoryStore.serialize()` 的实际字段」一致。
     * 于是下次新增落盘字段时**这个端点会先变红**，六处文案就不会静默过期。
     *
     * ⚠️ `self_service_delete_all: false` 是刻意暴露的短板：
     *   目前只能逐个删除监控点，没有「一键删除全部数据」。
     *   主动说出来比被用户发现更可信。
     */
    if (path === '/v1/data-handling' && req.method === 'GET') {
      return json(res, 200, {
        updated: '2026-10-17',
        summary: '监控点与快照存在服务器磁盘（重启/升级/补丁均不丢）；API Key 与 webhook HMAC 密钥只存哈希，从不存明文。',
        in_memory_only: [
          'check_feed_temporary_baseline', 'rate_limit_buckets',
          'admin_session', 'payment_link_pool',
        ],
        on_disk: {
          // ⚠️ 这里的标识符必须与 `MemoryStore.serialize()` 的**实际字段名**一致，
          //   否则 e2e 断言会报「未声明」—— 那正是这个端点存在的意义：
          //   新增落盘字段时先在这里变红，六处对外文案就不会静默过期。
          //   （首版我写成了业务名 monitor_url / entry_title，
          //     被测试当场抓出来：实际字段是 url / title。）
          'store.json': {
            // —— 监控点配置 ——
            monitors: [
              'id', 'url', 'name', 'intervalSeconds', 'keywords',
              'apiKeyId', 'status', 'createdAt',
              'lastCheckedAt', 'lastChangeAt', 'nextCheckAt',
              'lastFormat', 'lastError', 'lastCheckOk', 'errorCount',
              'trippedByCircuitBreaker',
              // channels 数组本身也落盘（但**没有 __secret** —— HMAC 密钥不入盘，
              // 见 MemoryStore.serialize() 里那道最后防线）
              'channels', 'channels[].url', 'channels[].type',
            ],
            // —— 快照基线（字段级 diff 必须保留旧值才能报出「X 变成 Y」）——
            snapshots: [
              'url', 'format', 'feedTitle', 'fetchedAt', 'contentHash',
              'items[].id', 'items[].title', 'items[].contentText', 'items[].link',
              'items[].author', 'items[].category', 'items[].publishedAt',
              // ★ items[].updated（2026-10-19 补）
              //   parser 修复前 Atom 的 updated 被整个丢弃；修复后它**确实会落盘**，
              //   而这里没声明 —— 端点本该是「新增落盘字段时先变红」的唯一真源，
              //   漏了它就是漏网的漂移。
              //   ⚠️ 现有 e2e 的双向断言**只查 monitors，不查 items[]**，
              //   所以这处漂移测试抓不到 —— 那是个已知盲区，见下方 notes。
              'items[].updated',
              'items[].contentHash',
              // ★ items[].category 现在**三协议都有值**（2026-10-19 修复）。
              //   此前仅 Atom / RSS 有；JSON Feed 走 items[].tags，
              //   而 `category` 恒被 TRACKED_FIELDS 跟踪 ——
              //   **JSON Feed 的分类变更完全检测不到**（实测 reason=hash_match，
              //   第一层粗筛就短路，连 diffItem 都进不去，零提示）。
              //   根因是规范用词差异：JSON Feed 叫 `tags`（作者自拟自由标签），
              //   RSS/Atom 叫 `category`（分类），两者并非完全同义。
              //   修法是**映射**（tags → category）而非改 TRACKED_FIELDS：
              //   后者会削弱 RSS/Atom 的能力，映射是加能力不是换能力。
              //   ⚠️ 两个键都保留、都落盘、都如实声明 —— tags 是 JSON Feed
              //   规范的原生字段，将来要单独追踪时数据已就位。
              'items[].tags',
              // ★ items[].publishedAtDerived（方案乙 2026-10-19）
              //   published 缺失时 publishedAt 由 updated 顶替，这个布尔标记
              //   告诉 diffItem「它是派生值，别拿它当变化信号」。
              //   ⚠️ 条件展开：仅派生条目才有此键，故只在派生源落盘时出现。
              'items[].publishedAtDerived',
            ],
            // —— 凭据与身份 ——
            apikeys: ['id', 'hash', 'label', 'createdAt', 'parentId', 'isBootstrap'],
          },
          'events-YYYY-MM-DD.jsonl': [
            // 聚合计数，不含 URL / feed 内容 / 邮箱
            'ts', 'ev', 'k', 'c', 'r', 's',
          ],
        },
        never_stored: [
          'api_key_plaintext',
          // ⚠️ HMAC 签名密钥 —— 泄露即可**伪造告警**，比 title 泄露严重得多
          //   （那是完整性问题，不只是隐私问题）。见 MemoryStore.serialize()。
          'webhook_hmac_secret',
          'credit_card_info',
        ],
        file: { path: DATA_FILE, mode: '0600', dir_mode: '0700' },
        retention: {
          per_monitor: '随监控点存续；每次检查覆盖上一轮快照',
          deletion: 'DELETE /v1/monitors/{id} 会一并删除该监控点的快照',
          statistics: '运营统计日志无自动清理（仅含聚合计数）',
        },
        self_service_delete_all: false,
        docs: `${PUBLIC_URL}/privacy`,
      });
    }

    if (path === '/pay') {
      const url = currentPayLink();
      if (!url) {
        // 配置缺失/非法 —— 返回可读的提示页，而不是 404 或白屏，
        // 否则客户会以为服务坏了（这正是「只声明不强制」的又一次变种：
        // 落地页声明了付费入口，但链接受限时没有任何兜底说明）
        const mail = `bruceonline2018@gmail.com`;
        const page = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FeedWatch Pro — payment temporarily unavailable</title>
<meta name="robots" content="noindex"><style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
background:#fbfaf8;color:#1a1a18;line-height:1.65;margin:0;
display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.box{max-width:520px;background:#fff;border:1px solid #e3e1db;border-radius:12px;padding:36px}
h1{font-size:21px;margin:0 0 14px;letter-spacing:-.01em}
p{margin:0 0 14px;color:#5c5b56;font-size:15px}
a{color:#c2410c}
</style></head><body><div class="box">
<h1>Payment is temporarily unavailable</h1>
<p>The payment link is being refreshed. Nothing is wrong with your card or your account.</p>
<p>In the meantime you can email <a href="mailto:${mail}">${mail}</a>
and we will send you a payment link within 1 business day.</p>
</div></body></html>`;
        res.writeHead(503, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        return res.end(page);
      }
      res.writeHead(302, { location: url, 'cache-control': 'no-store' });
      return res.end();
    }

    if (path === '/' || path === '/docs') {
      return json(res, 200, { name: 'FeedWatch MCP', version, docs: '/docs', health: '/health', mcp: '/mcp' });
    }

    // ---------- MCP Streamable HTTP ----------
    // ★ GET /mcp 返回说明页（2026-10-16 加）。
    //   MCP 的 tools/list 走 JSON-RPC over POST，GET 本就不支持 ——
    //   但直接访问看到 {"error":"无此端点：GET /mcp"} 很像故障报告。
    //   而这个 URL 会被审核员、潜在客户、以及以为服务坏了的用户直接打开。
    //   ⚠️ 放在鉴权之前是**刻意的**：说明页不含任何敏感信息，
    //   不需要 Key 也能看到「怎么连」——这正是它的转化目的。
    if (path === '/mcp' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      });
      return res.end(mcpInfoPage(version));
    }

    if (path === '/mcp' && req.method === 'POST') {
      // ★ 上线前审计修复：此前 /mcp 完全无鉴权。
      //   实测匿名可 tools/list、create_monitor、list_monitors、check_feed，
      //   500 次匿名创建仅耗 162ms。check_feed 还会让服务器对任意第三方
      //   地址持续出网（配合 SSRF 防护仍可打公网任意主机、放大攻击），
      //   list_monitors 则泄露所有租户的监控 URL。
      //   现在与 REST 区一致要求 x-api-key；MCP 客户端通过
      //   Authorization: Bearer <key> 或 x-api-key 头携带。
      const auth = authenticate(req);
      if (!auth) {
        res.setHeader('www-authenticate', 'Bearer realm="feedwatch"');
        return err(res, 401, 'MCP 端点需要鉴权（请用 x-api-key 头或 Authorization: Bearer）');
      }

      if (!rateLimit(`mcp:${auth.id}`, { windowMs: Number(process.env.MCP_WINDOW_MS ?? 60_000), max: Number(process.env.MCP_MAX ?? 120) })) {
    track('api_429', { keyId: auth?.id ?? null, source: 'mcp_ratelimited' });
      return err(res, 429, '请求过于频繁，请稍后再试');
      }

      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch { return err(res, 400, 'JSON 解析失败'); }

      // create_monitor 会写入持久状态，单独按更严格的额度限流
      if (body?.method === 'tools/call' && body?.params?.name === 'create_monitor') {
        if (!rateLimit(`create:${auth.id}`, { windowMs: CREATE_WINDOW_MS, max: CREATE_MAX })) {
        track('api_429', { keyId: auth?.id ?? null, source: 'create_ratelimited' });
      return err(res, 429, '监控点创建过于频繁，请稍后再试');
        }
      }

      const out = await handleMcpRequest(body, {
        store,
        apiKeyId: auth.id,
        maxMonitors: MAX_MONITORS,
        checkOnce: (u, prev = null) => checkOnce(u, store, prev),
        schedule: (m, opts) => service.schedule(m, opts),
        getEphemeralSnapshot: (k, u) => store.getEphemeralSnapshot(k, u),
        saveEphemeralSnapshot: (k, u, sn) => store.saveEphemeralSnapshot(k, u, sn),
        clearEphemeralSnapshot: (k, u) => store.clearEphemeralSnapshot(k, u),
      });
      if (body?.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      return json(res, 200, out);
    }

    // ---------- 路由存在性判定（先判 404 再鉴权，便于排错） ----------
    const KNOWN = [
      /^\/v1\/apikeys$/,
      /^\/v1\/usage$/,
      /^\/v1\/data-handling$/,
      /^\/v1\/monitors$/,
      /^\/v1\/monitors\/[^/]+$/,
      /^\/v1\/monitors\/[^/]+\/check$/,
      /^\/v1\/pay-links$/,
      /^\/v1\/stats$/,
    ];
    if (!KNOWN.some((re) => re.test(path))) {
      return err(res, 404, `无此端点：${req.method} ${path}`);
    }

    // ---------- 鉴权区 ----------
    const auth = authenticate(req);
    if (!auth) return err(res, 401, '缺少或无效的 API Key（请用 x-api-key 头）');

    // ---------- 付款链接库存（需鉴权） ----------
    //
    // ⚠️ **必须放在鉴权区之内**：这里能看出「还剩几条可用链接」，
    //    是内部运营信息。放在鉴权区外等于公开告诉访客「备用链接还剩几条」，
    //    对手可以据此判断什么时候来薅。而且这里**绝不能返回 URL 原文**，
    //    否则等于把备用链接直接送给任何人。
    if (path === '/v1/pay-links' && req.method === 'GET') {
      const { current, standby } = payLinkPool();
      return json(res, 200, {
        has_current: Boolean(current),
        standby_count: standby.length,
        total: (current ? 1 : 0) + standby.length,
        // 库存耗尽必须能一眼看出 —— 否则会一直撞「already paid」
        needs_new_link: !current || standby.length === 0,
      });
    }

    // ---------- 运营统计（需鉴权） ----------
    //
    // ⚠️ 与 /v1/pay-links 同理，放在鉴权区之内：
    //   「有几个人卡在 5 个监控点上限上」是**付费潜力的直接指标**，
    //   属于内部经营信息，不能让任何访客看到。
    //
    // 只返回**聚合计数**，不返回任何 Key id 明细 ——
    // 这样即使响应被截获，也拿不到「谁撞过墙」，
    // 日志文件本身也不会因为这个端点而扩大暴露面。
    if (path === '/v1/stats' && req.method === 'GET') {
      return json(res, 200, {
        ...summarize(),
        note:
          'conversion_signal 是最重要的一块：users_hit_users > 0 说明确实有人'
          + '想要更多监控点 → 付费档值得上线；= 0 则说明 5 个可能太宽松，或产品本身没被需要。'
          + '本端点只返回聚合计数，不含任何 Key 明细或客户数据。',
      });
    }

    if (path === '/v1/apikeys' && req.method === 'POST') {
      // ══ D8：签发仅限引导密钥（2026-10-16 补）══
      //
      // 原实现只校验「有没有 Key」，**不校验「这Key 是不是引导密钥」**。
      // 设计意图是「内部用引导密钥签发 → 发给客户 → 客户只用来建监控点」，
      // 但客户拿你发的 Key 同样能无限签发新 Key ——
      // 这等于把「一个客户」变成「无限多个客户」：配额空间可被无限复制。
      //
      // 客户 Key 泄露给第三方时，第三方就能自行签发，
      // 而受害者**无法只吊销那把泄露的 Key**（当前也无吊销能力）。
      if (!auth.isBootstrap) {
        //刻意返回 403 而非 404：这是「权限不足」而非「资源不存在」，
        //   403 便于调用方排错（404 会让人误以为端点不存在）。
        //   这与监控点跨租户访问返回 404 的约定不同，属刻意例外。
        return err(res, 403, 'API Key 签发仅限内部凭据，客户 Key 不可调用此端点', {
          hint: '如需更多 Key 请联系我们',
        });
      }

      // ── 以下限流（D4）按**根 Key** 分桶（D9）──
      // 客户若能签发，每把新 Key 都有独立 auth.id → 按 auth.id 分桶会被指数放大。
      // 按根 Key 分桶后，无论怎么签发都共用同一个桶。
      const rootId = store.resolveRootKeyId(auth.id);

      // 第一层：滑动窗口，防单账号短时间批量签发
      if (!rateLimit(`apikey:${rootId}`, { windowMs: KEY_ISSUE_WINDOW_MS, max: KEY_ISSUE_MAX })) {
track('api_429', { keyId: auth?.id ?? null, source: 'key_ratelimited_minute' });
        return err(res, 429, `API Key 签发过于频繁，每 ${KEY_ISSUE_WINDOW_MS / 60000} 分钟最多 ${KEY_ISSUE_MAX} 把`, {
          retry_after_seconds: KEY_ISSUE_WINDOW_MS / 1000,
        });
      }

      // 第二层：日配额，防跨天持续刷
      if (!rateLimit(`apikey-day:${rootId}`, { windowMs: KEY_ISSUE_DAY_MS, max: KEY_ISSUE_DAILY_MAX })) {
track('api_429', { keyId: auth?.id ?? null, source: 'key_ratelimited_day' });
        return err(res, 429, `API Key 日签发上限 ${KEY_ISSUE_DAILY_MAX} 把，已达上限`, {
          retry_after_seconds: KEY_ISSUE_DAY_MS / 1000,
          hint: '若需更多 Key 请联系（当前每客户一把，泄露只影响单个客户）',
        });
      }

      const raw = await readBody(req);
      let label = 'default';
      try { label = JSON.parse(raw || '{}').label ?? 'default'; } catch { /* ignore */ }
      const k = store.createApiKey(String(label).slice(0, 60), { parentId: auth.id });
      return json(res, 201, {
        id: k.id,
        key: k.raw,
        note: '此明文仅显示一次，请立即保存',
        parent_id: auth.id,
        remaining_today: `${KEY_ISSUE_DAILY_MAX - rateLimitPeek(`apikey-day:${rootId}`)} 把`,
      });
    }

    if (path === '/v1/monitors' && req.method === 'GET') {
      // 归属过滤：只返回本 key 创建的监控点。
      // 旧实现带 `|| !m.apiKeyId`，会把所有无归属（= 经 MCP 创建）的监控点
      // 暴露给任意持 key 者。
      const list = store.listMonitors().filter((m) => m.apiKeyId === auth.id);
      return json(res, 200, { count: list.length, monitors: list.map(view) });
    }

    if (path === '/v1/monitors' && req.method === 'POST') {
      if (!rateLimit(`create:${auth.id}`, { windowMs: CREATE_WINDOW_MS, max: CREATE_MAX })) {
        return err(res, 429, '监控点创建过于频繁，请稍后再试');
      }
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch {
        track('create_failed', { keyId: auth.id, reason: 'unknown' });
        return err(res, 400, 'JSON 解析失败');
      }
      if (!body.url) {
        track('create_failed', { keyId: auth.id, reason: 'invalid_url' });
        return err(res, 422, '缺少 url 字段');
      }
      if (typeof body.url !== 'string' || body.url.length > 2048) {
        // ⚠️ 只记「url 无效」这个分类，**绝不记 url 本身**
        track('create_failed', { keyId: auth.id, reason: 'invalid_url' });
        return err(res, 422, 'url 无效或过长');
      }

      // 免费层频率限制：必须在这里真正强制，不能只在 /v1/usage 里申报。
      //
      // ⚠️ 2026-10-15 引入的缺陷（回归测试证伪时发现）：
      //   FREE_INTERVALS 最初只用于计算 /v1/usage 的申报值，代码从不校验。
      //   实测传 intervalSeconds:900 直接 201 建成 —— 申报 6h、实际 15min，
      //   checks_per_day 偏差 24 倍。这与被修的 Bug 7（6h 被压成 60s，360 倍超额抓取）
      //   完全同型：一个常量声称约束 A，实际只作用于 B。
      //   教训：**任何"限制"必须同时做到「强制」与「申报」，只做后者等于撒谎。**
      if (body.intervalSeconds != null) {
        if (!FREE_INTERVALS.includes(Number(body.intervalSeconds))) {
          return err(res, 422,
            `免费层仅支持 ${FREE_INTERVALS.map((s) => `${s / 3600}h`).join(' / ')} 检查频率`,
            { allowed: FREE_INTERVALS, upgrade: `${PUBLIC_URL}/#pricing` });
        }
      }

      // 配额：/v1/usage 声明了 limit.monitors，此前完全没有强制
      const owned = store.listMonitors().filter((m) => m.apiKeyId === auth.id).length;
      if (owned >= MAX_MONITORS) {
        // ⭐ 唯一的付费信号：用户已经知道「我想要更多」，正卡在这。
        //   只记 keyId 与计数，不记 URL/正文 —— 边界见 src/telemetry.js
        track('limit_hit', { keyId: auth.id, count: owned });
        return err(res, 429, `监控点数量已达上限（${MAX_MONITORS}）`, {
          hint: '免费层最多 ' + MAX_MONITORS + ' 个监控点。付费档位可放宽至 25 / 100。',
          upgrade: `${PUBLIC_URL}/#pricing`,
        });
      }

      // ★ P0-1 修复（2026-10-17）：建点时**当场抓一次**验证 URL。
      //
      // 原来的问题：POST 直接建点返回 201，用户以为搞定了，
      //   但如果 URL 不是 feed（例：普通网页），失败要等到下一次定时检查
      //   才暴露 —— 实测 `https://www.tiici.com/`（无 feed）就是这样：
      //   建点 201 ✓ → 数小时后首次检查才报「不是有效的 RSS/RDF 结构」。
      //   用户等了几小时才知道自己填错了 URL。
      //
      // 现在：建点当场验证，不是 feed 就 422 + 明确的下一步指引。
      //
      // ⚠️ **顺序：配额 → 预检**（与 MCP 的 create_monitor 一致）。
      //   预检要出网，若放在配额之前，配额已满的用户每次重试都会先抓一次
      //   上游再被拒 —— 白烧出网流量，也给上游造成无意义的压力。
      let probe;
      try {
        probe = await checkOnce(body.url, store, null);
      } catch (e) {
        const code = probeReason(e);
        track('create_failed', { keyId: auth.id, reason: code });
        return err(res, 422, `无法监控该地址：${e.message}`, {
          code,
          hint: PROBE_HINTS[code] ?? '请确认该地址是一个可公开访问的 RSS / Atom / JSON Feed。',
          tried_url: body.url,
        });
      }

      // 预检通过：这一轮快照直接当基线，省掉一次重复抓取，
      // 也让用户立刻看到「首次检查会报什么」
      const m = store.createMonitor({ ...body, apiKeyId: auth.id });
      store.saveSnapshot(m.id, probe.snapshot);
      // ⚠️ 传完整间隔而非 schedule 默认的 5~60s 钳制值：
      //   预检刚抓过一次，默认值会在几秒后再抓同一份 —— 白烧出网，
      //   而且用户会看到「刚建点就有一条变更通知」，那是预检残留造成的假象。
      service.schedule(m, { firstDelayMs: m.intervalSeconds * 1000 });
      track('monitor_created', { keyId: auth.id, count: owned + 1 });
      return json(res, 201, {
        ...view(m),
        verified: {
          ok: true,
          format: probe.format,
          feed_title: probe.feedTitle,
          item_count: probe.changes.length,
          hint: '已验证该地址是可用的 feed，本次结果已作为基线，后续只推送与基线的差异。',
        },
      });
    }

    /**
     * 取监控点并校验归属 —— 修复 IDOR。
     *
     * 旧实现直接 store.getMonitor(id)，不做任何归属校验：只要猜到/拿到
     * 别人的 monitor id，GET / PATCH / DELETE / check 全部越权。
     * monitor id 是 `mon_` + UUID 前 12 位，不足以挡住枚举或信息泄露。
     */
    const ownedMonitor = (id, auth) => {
      const m = store.getMonitor(id);
      if (!m) return { status: 404 };
      if (m.apiKeyId !== auth.id) return { status: 404 };  // 不区分 403/404，避免探测
      return { monitor: m };
    };

    const monMatch = path.match(/^\/v1\/monitors\/([^/]+)$/);
    if (monMatch) {
      const found = ownedMonitor(monMatch[1], auth);
      if (found.status) return err(res, found.status, '监控点不存在');
      const m = found.monitor;

      if (req.method === 'GET') return json(res, 200, view(m));

      if (req.method === 'PATCH') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw); } catch { return err(res, 400, 'JSON 解析失败'); }
        if (body == null || typeof body !== 'object' || Array.isArray(body)) {
          return err(res, 422, '请求体必须是 JSON 对象');
        }
        const updated = store.updateMonitor(monMatch[1], body);
        if (!updated) return err(res, 404, '监控点不存在');

        // ★ 修复记录：原判断是 `if (body.status === 'active') schedule else stop`。
        //   PATCH 是**部分更新**语义 —— 用户只改 name / keywords / intervalSeconds 时
        //   根本不会带 status 字段，于是走进 else 分支把监控点停掉：
        //   实测「仅改名」这一下 innocuous 操作就足以让监控静默停止工作，
        //   而 API 返回 200，看不出任何异常（同 Bug 1/2 的静默失效家族）。
        //   现改为「只在显式指定 status 时才动调度」：
        //   · status==='paused' → 停
        //   · status==='active' → 重排（间隔可能已变）
        //   · 未提供 status    → 保持原调度状态不变
        if (body.status === 'paused') {
          service.stop(monMatch[1]);
        } else if (body.status === 'active') {
          service.schedule(updated);
        } else if (updated.intervalSeconds !== m.intervalSeconds && updated.status === 'active') {
          // 只改了间隔且仍是 active：重排以让新间隔生效
          service.schedule(updated);
        }
        return json(res, 200, view(updated));
      }

      if (req.method === 'DELETE') {
        service.stop(monMatch[1]);
        store.deleteMonitor(monMatch[1]);
        res.writeHead(204); res.end(); return;
      }
    }

    const checkMatch = path.match(/^\/v1\/monitors\/([^/]+)\/check$/);
    if (checkMatch && req.method === 'POST') {
      const found = ownedMonitor(checkMatch[1], auth);
      if (found.status) return err(res, found.status, '监控点不存在');
      const m = found.monitor;
      try {
        const r = await service.checkMonitor(m);
        return json(res, 200, r);
      } catch (e) {
        // 上游错误详情只进服务端日志，不回传给调用方
        console.error(`[feedwatch] check failed for ${m.id}:`, e?.message ?? e);
        return err(res, 502, '检查失败');
      }
    }

    const usageMatch = path.match(/^\/v1\/usage$/);
    if (usageMatch && req.method === 'GET') {
      const owned = store.listMonitors().filter((m) => m.apiKeyId === auth.id).length;
      return json(res, 200, {
        plan: 'free',
        monitors: owned,
        // 从环境变量派生，避免出现「页面写一个数、代码返回另一个数」的不一致
        limit: {
          monitors: MAX_MONITORS,
          frequency: FREE_INTERVALS.map((s) => `${s / 3600}h`),
          checks_per_day: Math.floor((86400 / MIN_INTERVAL) * MAX_MONITORS),
        },
        // ⚠️ 原文是「MVP 阶段为内存统计，生产环境将接入持久化」——
        //   那是2026-10-17 之前的**事实**，持久化已上线，这句话现在是**假的**，
        //   而且客户能在 API 响应里直接读到。改为指向唯一的真源端点。
        usage: `监控点统计取自磁盘持久化存储（重启不丢）；数据存储明细见 ${PUBLIC_URL}/v1/data-handling`,
      });
    }


    return err(res, 405, `不支持的方法：${req.method} ${path}`);
  } catch (e) {
    // 请求体超限是可预期的客户端错误，回 413，且不泄露任何内部细节
    if (e instanceof BodyTooLarge) return err(res, 413, '请求体过大');
    // ★ 修复信息泄露：旧实现把 e.message 原样回传。实测 2MB 请求体会返回
    //   {"error":"服务内部错误","detail":"请求体过大"}，任何内部异常
    //   （含连接被拒、DNS 细节、解析栈信息）都会暴露给调用方。
    console.error('[feedwatch] unhandled error:', e?.stack ?? e);
    return err(res, 500, '服务内部错误');
  }
});

function view(m) {
  return {
    id: m.id, url: m.url, name: m.name,
    interval_seconds: m.intervalSeconds, allowed_intervals: [...INTERVALS],
    keywords: m.keywords, status: m.status,
    created_at: m.createdAt, last_checked_at: m.lastCheckedAt,
    last_change_at: m.lastChangeAt ?? null, next_check_at: m.nextCheckAt ?? null,
    error_count: m.errorCount ?? 0, last_error: m.lastError ?? null,
    // 健康与调度状态分开表达，便于客户端区分「用户暂停」与「系统自动熔断」
    last_check_ok: m.lastCheckOk ?? null,
    tripped_by_circuit_breaker: m.trippedByCircuitBreaker ?? false,
    format: m.lastFormat ?? null,
  };
}

server.listen(PORT, HOST, () => {
  console.log(`[feedwatch] listening on http://${HOST}:${PORT}`);
  console.log(`[feedwatch] public URL (set PUBLIC_URL): ${PUBLIC_URL}`);
  console.log(`[feedwatch] MCP endpoint: ${PUBLIC_URL}/mcp`);
});

const shutdown = () => { service.stopAll(); server.close(() => process.exit(0)); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { server, service, isPrivateAddress };