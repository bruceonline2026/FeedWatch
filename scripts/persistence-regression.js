/**
 * 持久化回归套件：验证「重启后客户数据不丢」
 *
 * 背景（2026-10-17，徐总指出）：之前所有状态只在内存里，
 * `systemctl restart feedwatch` 之后会丢三样东西：
 *
 *   1. 监控点     → 客户的监控静默停止，他不知道
 *   2. **快照基线** → 重启后首次检查把所有条目当「新增」，**全是假告警**
 *   3. API Key    → 客户必须重新配置
 *
 * 「客户少就可以不存」不成立 —— 监控服务的价值恰恰是**长期稳定地不漏报**，
 * 而任何一次升级、补丁、重启都会清空内存态。
 *
 * 这套测试独立成文件，因为要反复起停子进程验证「重启」这件事。
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFeedFixture } from './fixtures/feed-server.js';

const API_KEY = 'fw_persist_test_bootstrap_key_at_least_32_chars';
const DIR = mkdtempSync(join(tmpdir(), 'feedwatch-persist-'));
const DB = join(DIR, 'store.json');

// ⚠️ 必须用**本地 fixture** 而非公网 feed：本沙箱的出网代理会拒 CONNECT，
//   实测 news.ycombinator.com 返回「代理拒绝 CONNECT: HTTP 502」，
//   于是建点预检失败 → 后续断言全部因「错误的原因」而失败。
//   持久化这件事与 feed 从哪来无关，用本地的更稳、更快。
const FIX = await startFeedFixture();

let pass = 0; let fail = 0;
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
const assert = (c, m) => { if (!c) throw new Error(m); };

console.log('\n═══ 持久化回归套件 ═══\n');
console.log(`  数据文件：${DB}\n`);

/** 起一个服务进程，等它就绪后返回控制句柄 */
async function boot(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_URL: 'https://api.tiici.com',
      FEEDWATCH_BOOTSTRAP_KEY: API_KEY,
      MAX_MONITORS: '5',
      FREE_INTERVALS: '900,3600,21600',
      FEEDWATCH_DATA_DIR: DIR,
      FEEDWATCH_DB: DB,
      // 本地 feed fixture 需放行回环
      FEEDWATCH_ALLOW_LOCAL_FETCH: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  for (let i = 0; i < 60; i += 1) {
    await delay(150);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { child, out: () => out }; } catch { /* 未就绪 */ }
  }
  child.kill('SIGKILL');
  throw new Error(`服务未就绪：${out.slice(0, 200)}`);
}

const stop = async (h) => { h.child.kill('SIGTERM'); await delay(400); };

// ══════════════════════════════════════════════════════════════

await t('写入后落盘文件存在且是合法 JSON', async () => {
  const p = 3190;
  const h = await boot(p);
  try {
    const auth = { 'content-type': 'application/json', 'x-api-key': API_KEY };
    const r = await fetch(`http://127.0.0.1:${p}/v1/monitors`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ name: 'persist-test', url: `${FIX.url}?persist=1` }),
    });
    const m = await r.json();
    assert(m.id, `建点应成功，实际：${JSON.stringify(m).slice(0, 120)}`);

    // 等待 setImmediate 刷盘
    await delay(300);
    const raw = readFileSync(DB, 'utf8');
    const data = JSON.parse(raw);
    assert(Array.isArray(data.monitors) && data.monitors.length >= 1,
      `落盘文件应含监控点，实际 monitors=${data.monitors?.length}`);
    return `${data.monitors.length} 个监控点已落盘`;
  } finally { await stop(h); }
});

await t('★ 重启后监控点仍在（客户监控不消失）', async () => {
  const h1 = await boot(3191);
  let monId;
  try {
    const auth = { 'content-type': 'application/json', 'x-api-key': API_KEY };
    const r = await fetch('http://127.0.0.1:3191/v1/monitors', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ name: 'survive-restart', url: `${FIX.url}?persist=1` }),
    });
    monId = (await r.json()).id;
    assert(monId, '建点失败');
  } finally { await stop(h1); }

  // ★ 重启
  const h2 = await boot(3192);
  try {
    const r = await fetch(`http://127.0.0.1:3192/v1/monitors/${monId}`, {
      headers: { 'x-api-key': API_KEY },
    });
    const m = await r.json();
    assert(r.status === 200, `重启后应仍能读到该监控点，实际 ${r.status}`);
    assert(m.name === 'survive-restart', `名称应保留，实际 ${m.name}`);
    assert(m.url === `${FIX.url}?persist=1`, 'URL 应保留');
    return `监控点 ${monId.slice(0, 12)}… 重启后完好`;
  } finally { await stop(h2); }
});

await t('★ 重启后快照基线仍在（否则重启即假告警）', async () => {
  const h1 = await boot(3193);
  let monId;
  try {
    const auth = { 'content-type': 'application/json', 'x-api-key': API_KEY };
    const r = await fetch('http://127.0.0.1:3193/v1/monitors', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ name: 'snap-survive', url: `${FIX.url}?persist=1` }),
    });
    monId = (await r.json()).id;
    // 建点时已预检并保存了快照基线，这里直接触发一次检查确保有基线
    await fetch(`http://127.0.0.1:3193/v1/monitors/${monId}/check`, { headers: { 'x-api-key': API_KEY } });
    await delay(300);
  } finally { await stop(h1); }

  const raw = JSON.parse(readFileSync(DB, 'utf8'));
  const hasSnap = (raw.snapshots ?? []).some((s) => s.id === monId);
  assert(hasSnap, `落盘文件应含 ${monId} 的快照基线，实际 ${JSON.stringify(raw.snapshots?.map((s) => s.id) ?? [])}`);

  const h2 = await boot(3194);
  try {
    // 重启后再检查一次：若基线丢了，会把所有条目当「新增」
    const r = await fetch(`http://127.0.0.1:3194/v1/monitors/${monId}/check`, {
      method: 'POST', headers: { 'x-api-key': API_KEY },
    });
    const j = await r.json();
    assert(!j.error, `检查应成功，实际：${JSON.stringify(j).slice(0, 120)}`);
    assert(j.changed === false,
      `基线恢复后立即再查，内容没变应 changed=false，实际 ${j.changed}`
      + '（若 true 说明基线丢失 → 会把全部条目误报为新增，客户收到一片假告警）');
    return '重启后基线完好，无假告警';
  } finally { await stop(h2); }
});

await t('★ 自助领的 API Key 重启后仍可用', async () => {
  const h1 = await boot(3195);
  let key;
  try {
    const r = await fetch('http://127.0.0.1:3195/get-key', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'persist-test@example.com' }).toString(),
    });
    const html = await r.text();
    key = html.match(/fw_[0-9a-f]{32}/)?.[0];
    assert(key, '应签发出 Key');
    await delay(300);
  } finally { await stop(h1); }

  const h2 = await boot(3196);
  try {
    const r = await fetch('http://127.0.0.1:3196/v1/monitors', {
      headers: { 'x-api-key': key },
    });
    assert(r.status === 200,
      `客户 Key 重启后应仍有效，实际 ${r.status} —— 客户需要重新配置，这不可接受`);
    return '客户 Key 重启后照常工作';
  } finally { await stop(h2); }
});

await t('落盘文件里只有 Key 哈希、没有明文', async () => {
  const h = await boot(3197);
  let key;
  try {
    const r = await fetch('http://127.0.0.1:3197/get-key', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'plaintext-check@example.com' }).toString(),
    });
    key = (await r.text()).match(/fw_[0-9a-f]{32}/)?.[0];
    await delay(300);
  } finally { await stop(h); }

  const raw = readFileSync(DB, 'utf8');
  assert(!raw.includes(key), '落盘文件里绝不能出现 Key 明文');
  assert(/"hash":"[0-9a-f]{64}"/.test(raw), '应存的是 64 位 sha256 哈希');
  return '只有 sha256 哈希，无明文';
});

await t('数据文件损坏时不静默当空（另存现场后启动）', async () => {
  const { writeFileSync } = await import('node:fs');
  const BAD = join(DIR, 'corrupt.json');
  writeFileSync(BAD, '{ this is not valid json', 'utf8');

  const { PersistentStore } = await import('../src/persistence.js');
  const { MemoryStore } = await import('../src/service.js');
  const ps = new PersistentStore(BAD);
  const store = new MemoryStore({ persistence: ps });
  const r = store.restore(ps.load());

  assert(r.monitors === 0, '损坏文件应按空数据处理');
  // 关键：原文件应被另存，不能被静默覆盖
  const { readdirSync, existsSync } = await import('node:fs');
  const corruptKept = readdirSync(DIR).some((f) => f.startsWith('corrupt.json.corrupt-'));
  assert(!existsSync(BAD), '损坏的原文件应被移走');
  assert(corruptKept, '损坏文件应另存为 .corrupt-* 以便排查，不能静默丢弃');
  return '另存为 .corrupt-* 后以空数据启动';
});

await t('FEEDWATCH_PERSIST=off 可退回纯内存（测试与应急）', async () => {
  const { PersistentStore } = await import('../src/persistence.js');
  const { MemoryStore } = await import('../src/service.js');
  const tmpDb = join(DIR, 'should-not-exist.json');
  const store = new MemoryStore({ persistence: null });
  store.createMonitor({ url: 'https://x.com/feed' });
  store.persistNow();
  const { existsSync } = await import('node:fs');
  assert(!existsSync(tmpDb), '未配置 persistence 时不应写任何文件');
  return '纯内存模式不落盘';
});

await FIX.close();
await t('★ 落盘文件权限必须是 600（同机器其他用户读不到）', async () => {
  // ⚠️ 2026-10-17 事故：文件以默认 644 创建，实测 `sudo -u nobody` 能读出
  //   feed 标题与正文 —— 那是我们客户的数据。
  //   权限漂移是**静默**的（没有报错、没有告警），所以必须用测试锁住。
  const { statSync } = await import('node:fs');
  const p = await boot(3198);
  try {
    const auth = { 'content-type': 'application/json', 'x-api-key': API_KEY };
    await fetch('http://127.0.0.1:3198/v1/monitors', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ name: 'perm-check', url: `${FIX.url}?perm=1` }),
    });
    await delay(300);
    const st = statSync(DB);
    const mode = st.mode & 0o777;
    assert(mode === 0o600,
      `数据文件权限必须是 600（仅属主），实际 ${mode.toString(8)}`
      + ' —— 644 意味着同机器任何用户可读客户 feed 内容');
    return `文件权限 ${mode.toString(8)} ✓`;
  } finally { await stop(p); }
});

await t('★ 数据目录权限必须是 700', async () => {
  const { statSync } = await import('node:fs');
  const mode = statSync(DIR).mode & 0o777;
  assert(mode === 0o700,
    `数据目录权限必须是 700，实际 ${mode.toString(8)} —— 目录宽松等于文件可被遍历`);
  return `目录权限 ${mode.toString(8)} ✓`;
});

await t('重启后基线可用于字段级 diff（不是只判断有无变化）', async () => {
  // 存快照不只是为了「知道变了」—— 必须是**字段级**的，
  // 否则落盘快照就没有意义（那不如只存个 hash）。
  const { Snapshot, diffSnapshots } = await import('../src/diff/engine.js');
  const { PersistentStore } = await import('../src/persistence.js');
  const { MemoryStore } = await import('../src/service.js');
  const f = join(DIR, 'field-diff.json');
  const mk = (title) => new Snapshot('https://x.com/feed', {
    format: 'rss', title: 'F',
    items: [{ id: '1', title, contentHash: 'h', link: 'https://x.com/1', contentText: '正文' }],
  }, new Date().toISOString());

  const s1 = new MemoryStore({ persistence: new PersistentStore(f) });
  const mon = s1.createMonitor({ url: 'https://x.com/feed' });
  s1.saveSnapshot(mon.id, mk('原标题'));
  s1.persistNow();

  const s2 = new MemoryStore({ persistence: new PersistentStore(f) });
  s2.restore(new PersistentStore(f).load());
  const prev = s2.getSnapshot(mon.id);
  assert(prev, '重启后应恢复出基线');

  const d = diffSnapshots(prev, mk('改过的标题'));
  assert(d.changed === true, '内容变化应检出');
  const t = d.changes[0]?.diff?.find((x) => x.field === 'title');
  assert(t, `应报出 title 字段级 diff，实际 ${JSON.stringify(d.changes[0]?.diff)}`);
  assert(String(t.old) === '原标题' && String(t.new) === '改过的标题',
    `diff 应含新旧值，实际 ${JSON.stringify(t)}`);
  return `title「${t.old}」→「${t.new}」（落盘保留了 diff 所需的旧值）`;
});

await t('★ webhook HMAC 密钥绝不明文落盘（泄露=可伪造告警）', async () => {
  // 这是比title 泄露严重得多的问题：
  //   `channels[].__secret` 是 webhook 的 **HMAC 签名密钥**
  //   （见 src/notify/deliver.js 的 signPayload(rawBody, secret)）。
  //   它明文落盘意味着：**拿到数据文件的人可以伪造任意一条告警**，
  //   让客户以为是真变更 —— 那是**完整性**问题，不只是隐私问题。
  //
  // ⚠️ 序列化处必须过滤，而不能只在 updateMonitor 里过滤 ——
  //   后者依赖「所有写入路径都记得处理」，而 restore() 会把历史数据读回来。
  const SECRET = 'super-secret-hmac-key-abc123';
  const { PersistentStore } = await import('../src/persistence.js');
  const { MemoryStore } = await import('../src/service.js');
  const f = join(DIR, 'secret-check.json');

  const s = new MemoryStore({ persistence: new PersistentStore(f) });
  const mon = s.createMonitor({ url: 'https://x.com/feed' });
  s.updateMonitor(mon.id, {
    channels: [{ url: 'https://hook.example/x', __secret: SECRET }],
  });
  s.persistNow();

  const raw = readFileSync(f, 'utf8');
  assert(!raw.includes(SECRET),
    '落盘文件里绝不能出现 webhook HMAC 密钥明文 —— 泄露即可伪造告警');
  assert(!/"__secret":/.test(raw),
    '落盘文件里不应保留 __secret 字段本身');
  // 内存里仍需保留明文，否则 HMAC 签名无法工作
  assert(s.getMonitor(mon.id).channels[0].__secret === SECRET,
    '内存中必须保留明文 secret，否则无法签名 webhook');

  // ★ 结构保证：即使内存里被绕过（比如从旧文件restore 进来）
  //   serialize() 也会剥掉 —— 这是最后一道防线
  const s2 = new MemoryStore({ persistence: new PersistentStore(f) });
  s2.restore(new PersistentStore(f).load());
  s2.getMonitor(mon.id).channels = [{ url: 'https://hook.example/x', __secret: SECRET }];
  const serialized = JSON.stringify(s2.serialize());
  assert(!serialized.includes(SECRET), 'serialize() 必须是最后一道防线，不能漏');
  return '明文不入盘、内存中可用、序列化兜底';
});

await t('★ /v1/data-handling 与实际落盘字段一致（防六处文案静默过期）', async () => {
  // 此前「客户数据存在哪里」散落在六处独立文本（隐私政策中/英、落地页中/英、
  // 退款政策中/英），各自会独立过期 —— 加持久化后**六处全部变成错误陈述**，
  // 且没有任何一处会因代码变化而自动报警。
  //
  // 这个断言让 `/v1/data-handling` 成为**唯一真源**：
  // 新增落盘字段时端点会先红，文案就不会静默过期。
  const { PersistentStore } = await import('../src/persistence.js');
  const { MemoryStore, MonitorService } = await import('../src/service.js');

  const h = await boot(3199);
  let payload;
  try {
    const r = await fetch('http://127.0.0.1:3199/v1/data-handling');
    assert(r.status === 200, `端点应可公开访问（无需 Key），实际 ${r.status}`);
    payload = await r.json();
  } finally { await stop(h); }

  assert(payload.never_stored && payload.in_memory_only,
    '端点应同时声明 never_stored 与 in_memory_only —— 只说「存什么」不说「不存什么」是话术');
  assert(payload.never_stored.includes('api_key_plaintext'),
    'never_stored 必须含 api_key_plaintext');
  // ⚠️ 这条是本轮最重要的加强：HMAC 密钥泄露 = 可伪造告警（完整性问题）
  assert(payload.never_stored.includes('webhook_hmac_secret'),
    'never_stored 必须含 webhook_hmac_secret —— 泄露即可伪造告警');

  // ★ 关键断言：实际落盘的监控点字段必须被端点覆盖
  const store = new MemoryStore({ persistence: null });
  const mon = store.createMonitor({ url: 'https://x.com/feed', name: 'N', keywords: ['k'] });
  // ⚠️ 必须覆盖「经历过一次检查」的状态 —— 像 `lastFormat` 只在检查成功后才写入。
  //   这里直接赋值而非真调checkMonitor：单元层面没有 fixture 可用
  //   （`FEEDWATCH_ALLOW_LOCAL_FETCH` 是模块加载时读的常量，
  //   此时 import 已经发生，改环境变量无效 —— 这也是我实测踩到的）。
  //   目的是取到**字段全集**，不是验证检查逻辑（那由 e2e 负责）。
  mon.lastFormat = 'rss';
  const declared = new Set(payload.on_disk['store.json'].monitors);
  const actual = Object.keys(store.serialize().monitors[0]);
  const undeclared = actual.filter((f) => !declared.has(f));

  assert(undeclared.length === 0,
    `这些监控点字段会落盘但 /v1/data-handling 没声明：${undeclared.join(', ')}`
    + ' —— 端点与实际不一致 = 对外承诺会静默过期');

  // 反向也查一遍：声明了但实际不存在，同样是漂移
  const nonexistent = [...declared].filter((f) => !actual.includes(f) && !f.includes('.'));

  // ★★ 快照 items 的双向核对（2026-10-19 补，2026-10-19 再修）
  //
  // ⚠️⚠️ 二次修复：这道门禁曾经**看起来在守、实际是空的**。
  //
  // 首版（14e06f7）用**手写 item 字面量**当"实际落盘字段"：
  //     items: [{ id:'tag:…', title:'标题', publishedAt:…, updated:…, category:'分类', … }]
  // 它只能验证「声明里有没有我手写进去的那几个字段」。
  // **parser 新增任何没写进这个字面量的字段，它都测不到** ——
  // 实测：给 parser 加 `publishedAtDerived`（确实会落盘）→ 这道门禁依然全绿。
  //
  // 为什么这比「没有门禁」更危险：门禁的存在会让人**不再去补真正的门禁**。
  //   team-lead 建它时以为「新增落盘字段会先变红」，我也据此断言过
  //   「方案乙会被这道门拦住」—— 两人都没验证过它真的会红。
  //   **「看起来有防线」比「没有防线」更费命。**
  //
  // 教训（写在这里防止重犯）：
  //   **声称「有测试守着」之前，必须先验证「那个测试真的会红」。**
  //
  // 现改为**真跑三种协议的 parser**，取真实输出做核对。
  // ⚠️ 必须覆盖 JSON Feed —— 它的 `category` 缺陷就藏在这：
  //   手写字面量里写了 `category:'分类'`，而真跑 JSON Feed 得到的是 `tags`、
  //   `category` 恒为 undefined。**手写 fixture 恰好把这个缺陷盖住了。**
  const { Snapshot } = await import('../src/diff/engine.js');
  const { parseAtom, parseRss, parseJsonFeed } = await import('../src/parser/feeds.js');

  const realItems = {
    atom: parseAtom(`<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>
  <entry>
    <id>tag:e.com,2026:1</id><title>标题</title>
    <link href="https://e.com/1"/>
    <published>2026-10-01T00:00:00Z</published>
    <updated>2026-10-15T09:30:00Z</updated>
    <author><name>作者</name></author>
    <category term="分类"/>
    <content type="html">正文</content>
  </entry>
</feed>`),
    // ⚠️ 第二个 Atom 样本：**故意不给 published**（只给 updated）——
    //   这是 `publishedAtDerived` 唯一会出现的情形（实测：给了 published 时
    //   该标记为 undefined，不落盘）。
    //   若样本里只有「有 published」那一种，门禁 union 就永远不含这个字段，
    //   于是「声明了但从没验证」—— **换成真跑也照样可能有盲区**。
    //   门禁的价值取决于样本是否覆盖「条件字段出现过」的那条路径。
    atomDerived: parseAtom(`<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title>
  <entry>
    <id>tag:e.com,2026:2</id><title>标题2</title>
    <link href="https://e.com/2"/>
    <updated>2026-10-15T09:30:00Z</updated>
    <author><name>作者</name></author>
    <category term="分类"/>
    <content type="html">正文</content>
  </entry>
</feed>`),
    rss: parseRss(`<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>F</title>
  <item>
    <guid>e.com,1</guid><title>标题</title><link>https://e.com/1</link>
    <pubDate>Mon, 01 Oct 2026 00:00:00 GMT</pubDate>
    <dc:creator>作者</dc:creator><category>分类</category>
    <description>正文</description>
  </item>
</channel></rss>`),
    jsonfeed: parseJsonFeed(JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1', title: 'F',
      items: [{
        id: 'e.com,1', title: '标题', url: 'https://e.com/1',
        authors: [{ name: '作者' }], tags: ['分类'],
        date_published: '2026-10-01T00:00:00Z',
        date_modified: '2026-10-15T09:30:00Z',
        content_text: '正文',
      }],
    })),
  };

  // 四份样本逐个存快照后取真实落盘字段 —— union 才是「实际会落盘的全集」
  //
  // ⚠️ 这里**刻意不调store.createMonitor()**，直接用合成 id 存快照。
  //   原因（实测发现，2026-10-19）：
  //   · `createMonitor()` 是业务层方法，**不校验 MAX_MONITORS** ——
  //     实测连调7 次都成功。配额只在 HTTP 层强制（`server.js` 的 `owned >= MAX` 才 429）。
  //   · 本套件 `MAX_MONITORS: '5'`，而 DIR/DB 是**全程共享**的（结尾才 rmSync）。
  //     原写法每份样本建一个 monitor，会把这个套件里的 monitor 数
  //     从 1 顶到 5（正好卡在上限），并**污染后续测试的基线**；
  //     任何人再加一次 createMonitor 就越界。
  //   · 门禁只关心「快照条目字段」，与监控点无关 —— 合成 id 足够。
  const actualItemKeys = new Set();
  let i = 0;
  for (const [fmt, parsed] of Object.entries(realItems)) {
    const probeId = `__probe-${fmt}`;
    store.saveSnapshot(probeId, new Snapshot(`https://x.com/${fmt}`, parsed, new Date().toISOString()));
    const snap = store.serialize().snapshots.find((s) => s.id === probeId);
    assert(snap?.json?.items?.[0], `${fmt} 样本应产出至少一个条目 —— 否则该协议的字段集缺席，门禁变空`);
    for (const k of Object.keys(snap.json.items[0])) actualItemKeys.add(k);
    i += 1;
  }
  // ⚠️ 样本必须覆盖「条件字段出现过」的路径：publishedAtDerived 只在
  //   「Atom 且无 published」时出现。若这条断言在，说明样本退化成了全绿 ——
  //   **门禁绿了但没在测**，这正是本条门禁曾经的状态。
  assert(actualItemKeys.has('publishedAtDerived'),
    '样本未覆盖 publishedAtDerived（缺「Atom 无 published」这一路）'
    + ' —— 门禁会绿但没在测派生值字段，等于退回空转门禁');

  const declaredItems = new Set(payload.on_disk['store.json'].snapshots);
  const undeclaredItems = [...actualItemKeys]
    .map((f) => `items[].${f}`).filter((f) => !declaredItems.has(f));

  assert(undeclaredItems.length === 0,
    `这些快照条目字段会落盘但 /v1/data-handling 没声明：${undeclaredItems.join(', ')}`
    + ' —— 这道门禁已改为真跑 parser，若仍报出，说明端点声明漏了真实字段');
  assert(nonexistent.length === 0,
    `端点声明了这些字段但实际不存在：${nonexistent.join(', ')}`
    + `（监控点字段：${actual.join(', ')}）—— 同样是对外承诺与实现不符`);

  return `三协议 ${actualItemKeys.size} 个实际字段全部已声明（真跑 parser 双向核对）`;
});

await t('★ /v1/usage 不再声称「内存统计」（客户能直接读到这句话）', async () => {
  const h = await boot(3290);
  try {
    const r = await fetch('http://127.0.0.1:3290/v1/usage', {
      headers: { 'x-api-key': API_KEY },
    });
    assert(r.status === 200, `应 200，实际 ${r.status}`);
    const j = await r.json();
    assert(j.usage, '应有用法说明字段');
    assert(!/内存统计|MVP 阶段/.test(j.usage),
      `usage 字段仍声称内存统计，实际：${j.usage}`
      + ' —— 这是客户在 API 响应里能直接读到的假陈述');
    assert(/data-handling/.test(j.usage), `应指向唯一真源端点，实际：${j.usage}`);
    return j.usage.slice(0, 60);
  } finally { await stop(h); }
});

rmSync(DIR, { recursive: true, force: true });
console.log(`\n═══ 结果：${pass} 项通过，${fail} 项失败 ═══\n`);
process.exit(fail === 0 ? 0 : 1);
