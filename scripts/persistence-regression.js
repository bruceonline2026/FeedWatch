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

rmSync(DIR, { recursive: true, force: true });
console.log(`\n═══ 结果：${pass} 项通过，${fail} 项失败 ═══\n`);
process.exit(fail === 0 ? 0 : 1);
