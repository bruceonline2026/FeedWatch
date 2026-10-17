/**
 * 后台管理页（GET/POST /admin）
 *
 * ── 为什么需要它 ──
 * 验证期的经营数据（有几个用户、几个人撞墙、失败原因分布）原本只能靠
 * `curl /v1/stats` 看 JSON —— 能看，但**每天要看的人不是工程师**。
 * 后台页把同一份数据变成一眼能判断的页面。
 *
 * ── 鉴权：不能用 API Key header ──
 * 浏览器打开页面时**不会**带 x-api-key 头，所以 header 鉴权在这里无效。
 * 做法：POST 时用密码换取一个短期 session cookie，GET 凭 cookie 进。
 *
 *   - 口令来自环境变量 ADMIN_PASSWORD，**不落盘、不进代码、不进日志**
 *   - 没有配置 ADMIN_PASSWORD 时端点**直接 404**（fail closed，
 *     绝不能出现「没配密码就等于不鉴权」）
 *   - 口令比较用 timingSafeEqual，避免时序侧信道
 *   - session 有效期 8 小时，服务重启即失效
 *
 * ── 安全边界（与 telemetry 同一套原则） ──
 * 后台**只显示聚合计数**，不显示任何 Key id、URL、邮箱。
 * 详见 src/telemetry.js 的硬边界说明。
 */

import { timingSafeEqual, randomBytes } from 'node:crypto';
import { summarize } from '../telemetry.js';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const SESSION_TTL_MS = 8 * 3600 * 1000;

/** key: token, value: 过期时间戳。内存态 —— 重启即全部失效 */
const sessions = new Map();

/** 定期清理过期 session，避免 Map 无限增长 */
let lastSweep = 0;
function sweep() {
  const now = Date.now();
  if (now - lastSweep < 600_000) return; // 每 10 分钟一次
  lastSweep = now;
  for (const [k, exp] of sessions) if (exp < now) sessions.delete(k);
}

/** 定长比较，避免 timing 侧信道 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // 长度不同则仍走一次比较，保持耗时接近
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export {
  sessionValid, newSession as newAdminSession, cookieHeader, safeEqual as safeEqualAdmin,
};

export function adminEnabled() {
  return ADMIN_PASSWORD.length >= 8;
}

function newSession() {
  const token = randomBytes(24).toString('base64url');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function sessionValid(req) {
  const cookies = String(req.headers.cookie ?? '');
  const m = /(?:^|;\s*)fw_admin=([A-Za-z0-9_-]+)/.exec(cookies);
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(m[1]); return false; }
  return true;
}

function cookieHeader(token) {
  return `fw_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 把 0/1/2 之类的计数渲染成一行条 —— 让人一眼看出比例 */
function bar(n, max) {
  const pct = max > 0 ? Math.max(2, Math.round((n / max) * 100)) : 0;
  return `<span class="bar" style="width:${pct}%"></span>`;
}

function distribution(title, obj) {
  const entries = Object.entries(obj ?? {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return `<p class="empty">暂无数据</p>`;
  const max = Math.max(...entries.map((e) => e[1]));
  return `<div class="dist">
    <h3>${esc(title)}</h3>
    ${entries.map(([k, v]) => `<div class="row">
      <span class="k">${esc(k)}</span>
      ${bar(v, max)}
      <span class="n">${v}</span>
    </div>`).join('\n    ')}
  </div>`;
}

function metric(label, value, hint = '') {
  return `<div class="metric">
    <div class="label">${esc(label)}</div>
    <div class="value">${value}</div>
    ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
  </div>`;
}

/**
 * 渲染后台页。
 * @param {object} opts
 * @param {object|null} opts.stats  已鉴权时的统计；未鉴权传 null
 * @param {string|null} opts.error 登录失败提示
 * @param {object} opts.extra      补充数据（收款链接库存、实时监控点等）
 */
export function adminPage({ stats = null, error = null, extra = {} } = {}) {
  const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#fbfaf8;--surface:#fff;--surface-2:#f5f4f0;
  --text:#1a1a18;--text-2:#5c5b56;--text-3:#8a8983;
  --border:#e3e1db;--border-2:#cfccc4;
  --accent:#c2410c;--accent-soft:#fff2e8;
  --ok:#0f6e56;--ok-soft:#e6f5ef;--warn:#854f0b;--warn-soft:#fdf3e3;
  --radius:12px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
}
body{font-family:var(--sans);background:var(--bg);color:var(--text);
  line-height:1.6;font-size:14px;-webkit-font-smoothing:antialiased;padding:28px 20px 60px}
.wrap{max-width:880px;margin:0 auto}
header{display:flex;align-items:baseline;gap:12px;margin-bottom:6px;flex-wrap:wrap}
h1{font-size:19px;font-weight:600;letter-spacing:-.01em}
.sub{color:var(--text-3);font-size:13px;margin-bottom:22px}
.card{background:var(--surface);border:0.5px solid var(--border);
  border-radius:var(--radius);padding:20px 22px;margin-bottom:16px}
.card h2{font-size:14px;font-weight:600;margin-bottom:4px}
.card .hint{font-size:12.5px;color:var(--text-3);margin-bottom:16px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(130px,1fr))}
.metric{background:var(--surface-2);border-radius:8px;padding:12px 14px}
.metric .label{font-size:11.5px;color:var(--text-2);margin-bottom:4px}
.metric .value{font-size:24px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.metric .hint{font-size:11.5px;color:var(--text-3);margin-top:2px}
.verdict{padding:12px 14px;border-radius:8px;font-size:14px;font-weight:500;margin-top:4px}
.verdict.yes{background:var(--ok-soft);color:var(--ok)}
.verdict.no{background:var(--surface-2);color:var(--text-2)}
.dist h3{font-size:12.5px;font-weight:500;color:var(--text-2);margin-bottom:10px}
.dist .row{display:flex;align-items:center;gap:10px;padding:4px 0;font-size:13px}
.dist .k{flex:0 0 168px;color:var(--text-2);font-family:var(--mono);font-size:12px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dist .bar{height:8px;background:var(--accent);border-radius:4px;min-width:3px;opacity:.75}
.dist .n{flex:0 0 46px;text-align:right;font-variant-numeric:tabular-nums;color:var(--text-2)}
.empty{font-size:13px;color:var(--text-3)}
table{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}
th,td{text-align:left;padding:8px 6px;border-bottom:0.5px solid var(--border);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
th{font-size:11.5px;font-weight:500;color:var(--text-3)}
td.n{text-align:right;font-variant-numeric:tabular-nums;width:70px}
form{margin:0}
label{display:block;font-size:12.5px;font-weight:500;margin-bottom:6px}
input{width:100%;max-width:280px;padding:9px 12px;border:0.5px solid var(--border-2);
  border-radius:8px;font:inherit;font-size:14px;background:#fff;color:var(--text)}
input:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
button{margin-top:12px;background:var(--accent);color:#fff;border:0;padding:10px 20px;
  border-radius:8px;font:inherit;font-size:14px;font-weight:500;cursor:pointer}
button:hover{background:#9a3412}
.err{background:#fceceb;color:#a32d2d;padding:10px 13px;border-radius:8px;
  font-size:13px;margin-bottom:16px}
.note{font-size:12.5px;color:var(--text-3);margin-top:14px;line-height:1.6}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:500}
.pill.ok{background:var(--ok-soft);color:var(--ok)}
.pill.warn{background:var(--warn-soft);color:var(--warn)}
.pill.bad{background:#fceceb;color:#a32d2d}
a{color:var(--accent)}
@media (max-width:520px){ .dist .k{flex-basis:110px} }
`;

  const login = `<div class="card">
  <h2>需要口令</h2>
  <p class="hint">这个页面显示经营数据（有几个用户、几个人卡在配额上限），
     因此需要口令。口令由服务器环境变量 <code>ADMIN_PASSWORD</code> 提供。</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <form method="POST" action="/admin">
    <label for="pw">管理口令</label>
    <input id="pw" name="password" type="password" required autofocus autocomplete="current-password">
    <button type="submit">进入</button>
  </form>
  <p class="note">会话有效期 8 小时；服务重启即失效。<br>
     页面只显示<b>聚合计数</b>，不显示任何 Key、URL 或邮箱。</p>
</div>`;

  if (!stats) {
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FeedWatch 后台</title>
<meta name="robots" content="noindex,nofollow">
<style>${CSS}</style></head><body><div class="wrap">
<header><h1>FeedWatch 后台</h1></header>
<p class="sub">经营数据 · 仅供内部</p>
${login}
</div></body></html>`;
  }

  const cs = stats.conversion_signal ?? {};
  const verdictYes = (cs.users_hit_limit ?? 0) >= 1;
  const pay = extra.payLinks ?? {};
  const live = extra.liveMonitors;

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FeedWatch 后台</title>
<meta name="robots" content="noindex,nofollow">
<style>${CSS}</style></head><body><div class="wrap">

<header><h1>FeedWatch 后台</h1>
  <span class="sub" style="margin:0">${esc(stats.first_day ?? '—')} 至 ${esc(stats.last_day ?? '—')}
  · ${stats.days} 天有记录</span>
</header>
<p class="sub">经营数据 · 仅供内部 · 刷新即更新</p>

<div class="card">
  <h2>付费信号</h2>
  <p class="hint">这是「有多少人想要更多配额」—— 判定「该不该做付费档」的直接依据。</p>
  <div class="grid">
    ${metric('累计领 Key', stats.keys_issued, '去重后 ' + stats.unique_users + ' 人')}
    ${metric('撞上限次数', stats.limit_hits, '同一 Key 多次撞墙只计人数')}
    ${metric('撞墙人数', cs.users_hit_limit ?? 0, '潜在付费用户')}
    ${metric('撞墙率', cs.hit_rate === null || cs.hit_rate === undefined
      ? '—' : Math.round((cs.hit_rate ?? 0) * 100) + '%', '撞墙 ÷ 领 Key')}
  </div>
  <div class="verdict ${verdictYes ? 'yes' : 'no'}">${esc(cs.verdict ?? '暂无数据')}</div>
</div>

<div class="card">
  <h2>使用情况</h2>
  <p class="hint">功能是否真被用起来 —— 建了 0 个监控点说明流程断了。</p>
  <div class="grid">
    ${metric('建监控点', stats.monitors_created)}
    ${metric('建点失败', stats.create_failed)}
    ${metric('检查失败', stats.check_failed)}
    ${metric('其他 429', stats.other_429, '限流命中')}
    ${metric('当前内存中', live?.monitors ?? '—', '重启即清空')}
    ${metric('运行天数', stats.uptime_days ?? '—')}
  </div>
</div>

<div class="card">
  <h2>收款链接库存</h2>
  <p class="hint">Payoneer 收款链接<b>单次使用</b>，用完必须换。备用耗尽时客户会看到「已付款」。</p>
  <table>
    <tr><td>当前链接</td><td class="n">
      <span class="pill ${pay.has_current ? 'ok' : 'bad'}">${pay.has_current ? '可用' : '无'}</span></td></tr>
    <tr><td>备用链接</td><td class="n">
      <span class="pill ${pay.standby_count > 1 ? 'ok' : pay.standby_count === 1 ? 'warn' : 'bad'}">
        ${pay.standby_count ?? 0} 条</span></td></tr>
    <tr><td>是否需要新建</td><td class="n">
      <span class="pill ${pay.needs_new_link ? 'warn' : 'ok'}">
        ${pay.needs_new_link ? '是' : '否'}</span></td></tr>
  </table>
  <p class="note">⚠️ <b>每次收到付款后立刻换链接</b>，否则下一个客户看到的是死链。<br>
     换法见 <code>docs/运营手册/更换收款链接操作手册.md</code>。</p>
</div>

<div class="card">
  <h2>失败与限流分布</h2>
  <p class="hint">失败原因分类找产品缺口（如大量 <code>not_feed</code> = URL 支持太窄）；
     429 分类看限流是否误伤正常用户。</p>
  <div style="display:grid;gap:22px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">
    ${distribution('创建失败原因', stats.fail_reasons)}
    ${distribution('429 触发位置', stats.r429_reasons)}
  </div>
</div>

<div class="card">
  <h2>数据边界</h2>
  <p class="note" style="margin-top:0">
    本页所有数字均为<b>聚合计数</b>，来自 <code>/opt/feedwatch/data/events-*.jsonl</code>。<br>
    那些日志里<b>没有</b>监控点 URL、feed 内容、邮箱、API Key —— 客户数据只在内存中。
    这与<a href="/privacy">隐私政策</a>的承诺一致，并有自动化测试担保。<br><br>
    统计端点：<code>GET /v1/stats</code>（需 API Key，返回同一份数据）。
  </p>
</div>

</div></body></html>`;
}