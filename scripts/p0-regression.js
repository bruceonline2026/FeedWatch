/**
 * P0 回归套件：2026-10-17 修的两个缺陷 + 顺手发现的第三个
 *
 * 独立文件，不塞进 e2e.js —— 因为它需要 fixture 控制 feed 内容
 * （要验证「就地修改已有条目」就必须能改变 XML）。
 *
 * 这三个测试不是为了「覆盖代码」，而是为了**锁住我们卖的那个能力**：
 * 「知道 feed 变了，而不只是变多了」。
 * 若它们不再报 modified，产品就退化成了所有竞品都能做的「只报新增」。
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFeedFixture } from './fixtures/feed-server.js';

const PORT = 3296;
const B = `http://127.0.0.1:${PORT}`;
const API_KEY = 'fw_p0_test_bootstrap_key_at_least_32_chars';
const AUTH = { 'x-api-key': API_KEY };
const DATA_DIR = join(tmpdir(), `feedwatch-p0-${process.pid}`);

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    fail += 1;
    console.log(`  ✗ ${name} — ${e.message}`);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const FIX = await startFeedFixture();

const child = spawn(process.execPath, ['src/server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    PUBLIC_URL: 'https://api.tiici.com',
    FEEDWATCH_BOOTSTRAP_KEY: API_KEY,
    MAX_MONITORS: '5',
    FREE_INTERVALS: '900,3600,21600',
    FEEDWATCH_DATA_DIR: DATA_DIR,
    FEEDWATCH_ALLOW_LOCAL_FETCH: '1',
    GETKEY_IP_MAX: '200',
    KEY_ISSUE_MAX: '200',
    KEY_ISSUE_DAILY_MAX: '500',
    CREATE_MAX: '500',
    MCP_MAX: '500',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
child.stdout.on('data', (d) => { serverOut += d.toString(); });
child.stderr.on('data', (d) => { serverOut += d.toString(); });

for (let i = 0; i < 40; i++) {
  await delay(150);
  try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* 未就绪 */ }
}

console.log('\n═══ P0 回归套件（2026-10-17） ═══\n');

const sleep = (ms) => delay(ms);

/** 调 MCP 工具并解析返回的 JSON 文本 */
async function mcpCall(name, args, key = API_KEY) {
  const r = await fetch(`${B}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-api-key': key,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  let outer = {};
  try { outer = JSON.parse(raw); } catch { /* SSE 或错误 */ }
  if (outer.error) return { __error: outer.error.message ?? JSON.stringify(outer.error) };
  const textBody = outer?.result?.content?.[0]?.text;
  if (!textBody) return outer?.result ?? {};
  try { return JSON.parse(textBody); } catch { return { raw: textBody }; }
}

const postJson = async (p, body, headers = {}) => {
  const r = await fetch(B + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, text, json };
};

const getJson = async (p, headers = {}) => {
  const r = await fetch(B + p, { headers });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, text, json };
};

const del = async (p, headers = {}) => {
  const r = await fetch(B + p, { method: 'DELETE', headers });
  await r.text();
  return r.status;
};

const selfserviceKey = async (email) => {
  const r = await fetch(`${B}/get-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email }).toString(),
  });
  const html = await r.text();
  return html.match(/fw_[0-9a-f]{32}/)?.[0] ?? '';
};

// ══════════════════════════════════════════════════════════════
// P0-2：check_feed 快照（产品核心能力）
// ══════════════════════════════════════════════════════════════

await t('★ 同一 URL 连查两次：第二次必须 changed:false（不误报）', async () => {
  const url = `${FIX.url}?p02=noise`;
  const a = await mcpCall('check_feed', { url });
  assert(a.changed === true, `首次应 changed:true，实际 ${a.changed}`);
  assert(a.reason === 'first_check', `首次原因应 first_check，实际 ${a.reason}`);
  assert(a.baseline?.stored === true, `应存下基线，实际 ${JSON.stringify(a.baseline)}`);

  await sleep(300);
  const b = await mcpCall('check_feed', { url });
  assert(b.changed === false,
    `第二次必须 changed:false，实际 ${b.changed}（reason=${b.reason}, count=${b.change_count}）`
    + ' —— 若仍是 first_check 说明快照没生效，字段级 diff 无法验证');
  assert(b.change_count === 0, `无变化时应 0 条变更，实际 ${b.change_count}`);
  return `首轮 ${a.change_count} 条新增 → 次轮 changed:false`;
});

await t('★★ 核心：能报出 modified 并给出字段级 diff', async () => {
  const url = `${FIX.url}?p02=modified`;

  const first = await mcpCall('check_feed', { url });
  assert(first.changed === true, `首轮应报变更，实际 ${first.changed}`);
  assert(first.changes.some((c) => c.title === 'Item One'),
    `基线应含 "Item One"，实际：${first.changes.map((c) => c.title).join(', ')}`);

  // ★ 就地改标题 —— 竞品全部漏掉的这一类变化
  FIX.setTitleOfFirst('Item One (PRICE RAISED)');
  await sleep(300);

  const second = await mcpCall('check_feed', { url });
  assert(second.changed === true, `标题被改后必须 changed:true，实际 ${second.changed}`);
  assert(second.reason !== 'first_check', `此处不应是 first_check，实际 ${second.reason}`);
  assert(second.change_count === 1, `只改一个字段应恰好 1 条变更，实际 ${second.change_count}`);

  const mod = second.changes.find((c) => c.change_type === 'modified');
  assert(mod, `必须报出 modified，实际类型：${[...new Set(second.changes.map((c) => c.change_type))].join(',')}`);

  // ⚠️ diff 是**数组**，元素形如 `{ field, changed, old, new }`，
  //   不是 `{ title: { old, new } }` 这样的对象。
  //   我第一版按对象写断言 → `fields = []` → 又一次误判成「代码没生效」。
  assert(Array.isArray(mod.diff), `diff 应为数组，实际 ${typeof mod.diff}`);
  assert(mod.diff.length > 0, 'modified 必须带 diff（哪些字段变了），实际为空');

  const titleDiff = mod.diff.find((d) => d.field === 'title');
  assert(titleDiff, `改的是 title，diff 里没有，实际字段：${mod.diff.map((d) => d.field).join(', ')}`);
  assert(titleDiff.changed === true, 'diff 元素应标记 changed:true');
  assert(String(titleDiff.old).includes('Item One'),
    `diff.old 应是改之前的标题，实际：${JSON.stringify(titleDiff.old)}`);
  assert(String(titleDiff.new).includes('PRICE RAISED'),
    `diff.new 应是改之后的标题，实际：${JSON.stringify(titleDiff.new)}`);

  FIX.setTitleOfFirst('Item One');
  return `报出 modified：title「${titleDiff.old}」→「${titleDiff.new}」`;
});

await t('★★ P0-3 非正文字段逐一可检出（改前只有 contentText 可以）', async () => {
  // P0-3 根因：Snapshot 的粗筛 contentHash 原本只由 i.contentHash 构成，
  // 而 i.contentHash = sha256(cleanContent) —— **只有正文**。
  // 于是改 title / link / author 等字段时哈希恒定，
  // 第一层直接 `return { changed:false }`
  // → **6 个 TRACKED_FIELDS 里 5 个永远检测不到**。
  //
  // 我们承诺「告诉你哪个字段变了」，竞品只会说「这页变了」——
  // 那时我们连「变了」都报不出来，退化得比竞品还差。
  const cases = [
    ['title', (v) => FIX.setTitleOfFirst(v), 'Item One (X)', 'Item One'],
    ['link', (v) => FIX.setLinkOfFirst(v), 'https://example.com/1-x', 'https://example.com/1'],
    ['description', (v) => FIX.setDescriptionOfFirst(v), 'Changed description', 'Original description one'],
  ];

  const missed = [];
  for (const [field, mutate, changedTo, resetTo] of cases) {
    await mcpCall('check_feed', { url: `${FIX.url}?f3=${field}` });
    mutate(changedTo);
    await sleep(250);
    const next = await mcpCall('check_feed', { url: `${FIX.url}?f3=${field}` });
    const mod = next.changes?.find((c) => c.change_type === 'modified');
    // description 在 parser 里映射为 contentText，字段名可能不同
    const hit = mod?.diff?.some((d) => d.field === field || (field === 'description' && d.field === 'contentText'));
    if (!hit) missed.push(field);
    mutate(resetTo);
  }
  assert(missed.length === 0,
    `这些字段改了却检不出：${missed.join(', ')} —— 粗筛哈希只覆盖正文时，非正文字段全部失效（P0-3）`);
  return 'title / link / description 均可检出';
});

await t('★★ 租户隔离：A 的基线不影响 B', async () => {
  const url = `${FIX.url}?p02=tenant`;
  const keyA = await selfserviceKey('tenant-iso-a@example.com');
  const keyB = await selfserviceKey('tenant-iso-b@example.com');
  assert(keyA && keyB && keyA !== keyB, '应领到两把不同的 Key');

  const a1 = await mcpCall('check_feed', { url }, keyA);
  assert(a1.reason === 'first_check', `A 首轮应 first_check，实际 ${a1.reason}`);

  FIX.setTitleOfFirst('Item One (changed by tenant test)');
  await sleep(300);

  const b1 = await mcpCall('check_feed', { url }, keyB);
  assert(b1.reason === 'first_check',
    `B 首轮查同一 URL 应是 first_check，实际 ${b1.reason}`
    + ' —— 若不是，说明快照未按 Key 隔离，跨用户数据泄露');

  FIX.setTitleOfFirst('Item One');
  return 'A 建基线后 B 仍为首轮（隔离生效）';
});

await t('★★ resetBaseline 能显式重置', async () => {
  const url = `${FIX.url}?p02=reset`;
  await mcpCall('check_feed', { url });
  FIX.setTitleOfFirst('Item One (before reset)');
  await sleep(300);

  const beforeReset = await mcpCall('check_feed', { url });
  assert(beforeReset.changed === true, `改内容后应 changed:true，实际 ${beforeReset.changed}`);

  const after = await mcpCall('check_feed', { url, resetBaseline: true });
  assert(after.reason === 'first_check', `重置后应 first_check，实际 ${after.reason}`);

  FIX.setTitleOfFirst('Item One');
  return 'resetBaseline 生效';
});

await t('★★ 临时快照每租户有上限（防资源耗尽）', async () => {
  // 上限是**每租户 20**（EPHEMERAL_SNAPSHOT_PER_KEY）。
  // 早期版本做成全局 200 → 单个租户就能占满全局桶，把别人饿死 ——
  // 「有上限」变成了「别人受害」。
  const key = await selfserviceKey('lru-probe@example.com');

  // 另开一个租户验证「不被别人饿死」
  const otherKey = await selfserviceKey('lru-other@example.com');
  await mcpCall('check_feed', { url: `${FIX.url}?lru=other` }, otherKey);
  await sleep(150);
  const otherStillThere = await mcpCall('check_feed', { url: `${FIX.url}?lru=other` }, otherKey);
  assert(otherStillThere.reason !== 'first_check',
    `另一个租户的基线应仍在，实际 ${otherStillThere.reason} —— 说明被别人的写入挤掉了`);

  // 本租户连查 25 个不同 URL（超过 20）→ 最早的应被淘汰
  for (let i = 0; i < 25; i += 1) {
    await mcpCall('check_feed', { url: `${FIX.url}?lru=${i}` }, key);
  }
  const first = await mcpCall('check_feed', { url: `${FIX.url}?lru=0` }, key);
  assert(first.reason === 'first_check',
    `本租户超过上限后最早条目应被 LRU 淘汰（回到 first_check），实际 ${first.reason}`
    + ' —— 若仍非 first_check，说明 Map 无上限，内存可被无限撑大');
  return '每租户 20 条上限生效，且不饿死其他租户';
});

// ══════════════════════════════════════════════════════════════
// P0-1：建点预检
// ══════════════════════════════════════════════════════════════

await t('★ 非 feed 地址当场被拒且给出下一步指引', async () => {
  // ⚠️ 必须先清配额，否则拿到的是 429 而非 422 —— 断言就「因为错误的原因而通过」了。
  //
  // ⚠️⚠️ **要用自助 Key 清理**：前几条测试用 selfserviceKey 领的 Key 建点，
  //   而归属校验是按 apiKeyId 过滤的 —— 用引导密钥的 AUTH 根本看不到、也删不掉
  //   那些点，于是「清理」静默无效（第一步就踩了这个坑）。
  //   拿到的是引导密钥 → list 返回空 → for 循环空转 → 配额其实还是满的。
  const cleanup = async (headers) => {
    const list = await getJson('/v1/monitors', headers);
    const n = list.json?.monitors?.length ?? 0;
    for (const m of list.json?.monitors ?? []) await del(`/v1/monitors/${m.id}`, headers);
    return n;
  };
  // 用引导密钥能清多少清多少（自助 Key 的点由下面那段按 email 逐个清）
  await cleanup(AUTH);

  // 逐个自助 Key 清理：这些点是它们建的
  for (const email of ['tenant-iso-a@example.com', 'tenant-iso-b@example.com', 'lru-probe@example.com']) {
    const k = await selfserviceKey(email);
    if (k) await cleanup({ 'x-api-key': k });
  }

  const after = await getJson('/v1/monitors', AUTH);
  assert((after.json?.monitors?.length ?? 0) === 0,
    `清理后应无残留监控点，实际 ${after.json?.monitors?.length} 个 —— 配额没清干净会让本条测试假通过`);

  // 诊断：这个 URL 现在还能抓到吗
  const probeNow = await fetch(FIX.htmlUrl).then(r => r.headers.get('content-type')).catch(e => 'ERR ' + e.message);
  console.log('      [诊断] fixture htmlUrl 现在返回:', probeNow);

  const r = await postJson('/v1/monitors', { name: 'not-a-feed', url: FIX.htmlUrl }, AUTH);
  assert(r.status === 422, `非 feed 应当场 422，实际 ${r.status}: ${(r.text ?? '').slice(0, 300)}`);
  assert(r.json?.code, `应给出分类 code，实际 ${JSON.stringify(r.json).slice(0, 120)}`);
  assert(/feed|atom|rss|网页/i.test(r.json?.hint ?? ''),
    `hint 应告诉用户下一步，实际：${r.json?.hint}`);
  return `当场 422 · code=${r.json.code} · 有可操作指引`;
});

await t('★ 合法 feed 立即返回验证结果', async () => {
  const r = await postJson('/v1/monitors', { name: 'fixture', url: `${FIX.url}?ok=1` }, AUTH);
  assert(r.status === 201, `合法 feed 应 201，实际 ${r.status}`);
  assert(r.json?.verified?.ok === true, `应返回 verified.ok，实际 ${JSON.stringify(r.json?.verified)}`);
  assert(r.json?.verified?.format === 'rss', `应识别 rss，实际 ${r.json?.verified?.format}`);
  assert(r.json?.verified?.item_count >= 2, `应报条目数，实际 ${r.json?.verified?.item_count}`);
  if (r.json?.id) await del(`/v1/monitors/${r.json.id}`, AUTH);
  return `201 + verified(rss, ${r.json?.verified?.item_count} 条)`;
});

await t('★ 预检不消耗配额（配额满时先 429，不浪费出网）', async () => {
  // 建满 5 个 → 再用一个**明显非 feed** 的 URL 试：
  // 期望 429（配额先拦），而不是 422（预检先拦）。
  // 若返回 422，说明顺序是「预检在前」—— 配额满时用户每次重试
  // 都会白烧一次出网，正是这次要防的。
  //
  // ⚠️ 开头先清理上一条测试可能残留的监控点，否则配额本就满了，
  // 断言会「因为错误的原因而通过」。
  const existing = await getJson('/v1/monitors', AUTH);
  for (const m of existing.json?.monitors ?? []) await del(`/v1/monitors/${m.id}`, AUTH);

  const made = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await postJson('/v1/monitors', { name: `q${i}`, url: `${FIX.url}?q=${i}` }, AUTH);
    if (r.status === 201) made.push(r.json.id);
    else throw new Error(`第 ${i} 个应 201，实际 ${r.status}: ${(r.text ?? '').slice(0, 120)}`);
  }
  assert(made.length === 5, `应能建 5 个监控点，实际 ${made.length}`);

  const before = FIX.hits();
  const r = await postJson('/v1/monitors', { name: 'over', url: FIX.htmlUrl }, AUTH);
  assert(r.status === 429,
    `配额满时非 feed URL 应先被配额拦下（429），实际 ${r.status}`
    + ' —— 若为 422，说明预检在配额之前，白烧了一次出网');

  // 关键：确认**真的没有出网**（配额拦下就该一次都不抓）
  assert(FIX.hits() === before,
    `配额拦下时不应再出网，实际多抓了 ${FIX.hits() - before} 次`);

  for (const id of made) await del(`/v1/monitors/${id}`, AUTH);
  return '配额满 → 先 429，且零出网';
});

// ══════════════════════════════════════════════════════════════
// 第三个 bug：MCP 建点从不调度
// ══════════════════════════════════════════════════════════════

await t('★★★ MCP create_monitor 必须进入调度', async () => {
  // 第三个 bug：MCP 建点路径从不调用 service.schedule()，
  // 监控点建得出来、列得出来，但永远不会被定时检查 —— 用户以为在监控。
  // ⚠️ 先清配额，否则会因「配额满」而拿到错误的原因（假绿）。
  const existing = await getJson('/v1/monitors', AUTH);
  for (const m of existing.json?.monitors ?? []) await del(`/v1/monitors/${m.id}`, AUTH);

  const r = await mcpCall('create_monitor', { name: 'mcp-sched', url: `${FIX.url}?mcp=sched` });
  const mid = r.monitor?.id;
  assert(mid, `应返回 monitor id，实际：${JSON.stringify(r).slice(0, 150)}`);

  const viaRest = await getJson(`/v1/monitors/${mid}`, AUTH);
  assert(viaRest.status === 200, `应能用 REST 读到，实际 ${viaRest.status}`);
  assert(viaRest.json?.status === 'active', `应为 active，实际 ${viaRest.json?.status}`);
  assert(viaRest.json?.next_check_at,
    `应有 next_check_at（说明已排定调度），实际 ${viaRest.json?.next_check_at}`);
  assert(!viaRest.json?.tripped_by_circuit_breaker, '新点不应带熔断标记');

  await del(`/v1/monitors/${mid}`, AUTH);
  return 'next_check_at 已排定（修复前是 null）';
});

await t('★ MCP create_monitor 对非 feed 也要当场拒', async () => {
  const existing = await getJson('/v1/monitors', AUTH);
  for (const m of existing.json?.monitors ?? []) await del(`/v1/monitors/${m.id}`, AUTH);

  const r = await mcpCall('create_monitor', { name: 'mcp-bad', url: FIX.htmlUrl });
  const msg = r.__error ?? JSON.stringify(r);
  assert(/not a feed|feed|atom|rss/i.test(msg),
    `MCP 路径也必须当场拒绝非 feed，实际：${msg.slice(0, 160)}`);
  return '当场拒绝并给出可读原因';
});

child.kill('SIGTERM');
await FIX.close();
await delay(300);

console.log(`\n═══ 结果：${pass} 项通过，${fail} 项失败 ═══\n`);
process.exit(fail === 0 ? 0 : 1);
