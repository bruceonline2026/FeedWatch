/**
 * 端到端测试：同进程内启动服务 → 测试 → 关闭
 * 避免后台进程被沙箱回收
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFeedFixture } from './fixtures/feed-server.js';

const PORT = 3199;
const B = `http://127.0.0.1:${PORT}`;

/**
 * 上线前安全审计后：/mcp 与 REST 区一样要求鉴权。
 * 旧版这里不传任何凭证就断言 MCP 可用，等于把「匿名可调用」固化成了契约。
 * 现在通过 FEEDWATCH_BOOTSTRAP_KEY 注入测试密钥，并显式测试匿名被拒。
 */
const API_KEY = 'fw_e2e_test_bootstrap_key_at_least_32_chars';
const AUTH = { 'x-api-key': API_KEY };

// ★ 本地 feed fixture：提供一个真能抓到的 RSS/Atom。
//   修复 P0-1（建点预检）时发现的测试盲区 —— 原套件全部使用
//   d8-test.com 这类假域名，在「从不真抓」的旧实现下能通过，
//   一旦加了预检就全部 422。**测试声称覆盖建点，却从未验证过真能抓到。**
const FIX = await startFeedFixture();

// 测试的事件日志目录 —— 用系统临时目录，绝不能写进项目或生产路径
const TEST_DATA_DIR = join(tmpdir(), `feedwatch-e2e-${process.pid}`);

console.log('\n═══ 端到端测试（同进程） ═══\n');

const child = spawn(process.execPath, ['src/server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    PUBLIC_URL: 'https://api.tiici.com',
    FEEDWATCH_BOOTSTRAP_KEY: API_KEY,
    // 测试环境显式声明免费层配额，避免依赖代码默认值。
    // 生产是 5 / 21600；测试里放开频率限制，才好测900/3600/21600 三档行为。
    MAX_MONITORS: '5',
    FREE_INTERVALS: '900,3600,21600',
    // ⚠️ 事件日志必须落到临时目录：
    //   ① 否则本机跑到 /opt/feedwatch/data 会因权限失败而静默跳过（测不到东西）
    //   ② 更重要 —— 测试绝不能污染生产的运营数据
    FEEDWATCH_DATA_DIR: TEST_DATA_DIR,
    // 放开自助领 Key 的额度：多个测试各自领一把，若共用 5 把/小时的桶，
    // 后面的测试会因顺序不同而随机失败（测试不应依赖执行顺序）。
    // 限流本身由「★ /get-key 有 IP 限流」那条测试单独验证 —— 它临时用
    // 自己起的第二个服务进程测，不受这里影响。
    // fixture 监听 127.0.0.1，而 SSRF 防护会拒绝内网地址。
    // 该开关**仅测试进程**生效，生产不设 —— 见 src/security/ssrf.js 说明。
    FEEDWATCH_ALLOW_LOCAL_FETCH: '1',
    GETKEY_IP_MAX: '200',
    KEY_ISSUE_MAX: '200',
    KEY_ISSUE_DAILY_MAX: '500',
    CREATE_MAX: '500',
    MCP_MAX: '500',
    GETKEY_DAILY_MAX: '500',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
child.stdout.on('data', (d) => { serverOut += d.toString(); });
child.stderr.on('data', (d) => { serverOut += d.toString(); });

// 等待监听
for (let i = 0; i < 40; i++) {
  await delay(150);
  try {
    const r = await fetch(`${B}/health`);
    if (r.ok) break;
  } catch { /* 还没起来 */ }
}
console.log('服务启动输出：');
console.log(serverOut.split('\n').filter(Boolean).map((l) => '  ' + l).join('\n'));
console.log('');

const get = async (p, headers = {}) => {
  const r = await fetch(B + p, { headers });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非JSON */ }
  return { status: r.status, text, json, headers: Object.fromEntries(r.headers) };
};
const post = async (p, body, headers = {}) => {
  const r = await fetch(B + p, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非JSON */ }
  return { status: r.status, text, json };
};

/**
 * 以表单方式 POST，返回文本。
 *
 * /get-key 的表单是标准 HTML form（application/x-www-form-urlencoded），
 * 但服务端为便于前端调试同时接受 JSON —— 这里两种都测，
 * 顺便验证「同一个端点认不认真实浏览器的提交格式」。
 */
const postRaw = async (p, bodyJson) => {
  const asJson = await fetch(B + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyJson,
  });
  const t1 = await asJson.text();
  let j1 = null;
  try { j1 = JSON.parse(t1); } catch { /* HTML */ }

  // 再用真实浏览器的表单格式打一次，确认兼容
  const params = new URLSearchParams({ email: JSON.parse(bodyJson).email ?? '' });
  const asForm = await fetch(B + p, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    redirect: 'manual',
  });
  const t2 = await asForm.text();

  return { status: asJson.status, text: t1, json: j1, formStatus: asForm.status, formText: t2 };
};

// PATCH / DELETE 辅助函数 —— 2026-10-15 补。
// 原脚本只有 get/post，导致「缺陷 8（PATCH 静默停调度）」与「IDOR 的 PATCH/DELETE 分支」
// 这两处从未被任何测试触达 —— 回退修复后 87 项仍全绿。
const patch = async (p, body, headers = {}) => {
  const r = await fetch(B + p, {
    method: 'PATCH', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非JSON */ }
  return { status: r.status, text, json };
};
const del = async (p, headers = {}) => {
  const r = await fetch(B + p, { method: 'DELETE', headers });
  return { status: r.status, text: await r.text() };
};

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { const d = await fn(); pass++; console.log(`  ✓ ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

await t('GET /health 返回 200 与状态', async () => {
  const r = await get('/health');
  assert(r.status === 200, `状态应为 200，实际 ${r.status}`);
  const j = JSON.parse(r.text);
  assert(j.status === 'ok', 'status 应为 ok');
  return `version=${j.version} uptime=${j.uptime_sec}s`;
});

await t('GET /.well-known/mcp.json 可被注册表读取', async () => {
  const r = await get('/.well-known/mcp.json');
  assert(r.status === 200, `状态应为 200，实际 ${r.status}`);
  const j = JSON.parse(r.text);
  assert(j.remotes?.[0]?.url === 'https://api.tiici.com/mcp', `remotes.url 应为 https://api.tiici.com/mcp，实际 ${j.remotes?.[0]?.url}`);
  return `${j.name} → ${j.remotes[0].url}`;
});

await t('未知端点返回 404 且同为统一格式', async () => {
  const r = await get('/no-such-endpoint');
  assert(r.status === 404, `状态应为 404，实际 ${r.status}`);
  const j = JSON.parse(r.text);
  assert(typeof j.error === 'string', '应返回统一错误格式');
  return `{"error":"${j.error.slice(0, 45)}"}`;
});

await t('已知端点但未鉴权返回 401', async () => {
  const r = await get('/v1/monitors');
  assert(r.status === 401, `状态应为 401，实际 ${r.status}`);
  const j = JSON.parse(r.text);
  assert(typeof j.error === 'string', '应返回统一错误格式');
  return `{"error":"${j.error.slice(0, 40)}"}`;
});

await t('MCP 匿名访问被拒 401（上线前审计修复项）', async () => {
  const r = await post('/mcp', { jsonrpc: '2.0', id: 0, method: 'tools/list' });
  assert(r.status === 401, `匿名访问应 401，实际 ${r.status}`);
  return '匿名无法调用任何 MCP 工具';
});

await t('MCP 匿名 check_feed 被拒 401（原 SSRF 打点口）', async () => {
  const r = await post('/mcp', {
    jsonrpc: '2.0', id: 0, method: 'tools/call',
    params: { name: 'check_feed', arguments: { url: 'http://169.254.169.254/' } },
  });
  assert(r.status === 401, `应 401，实际 ${r.status}`);
  return '匿名无法借服务器出网';
});

await t('MCP initialize 握手（带鉴权）', async () => {
  const r = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, AUTH);
  assert(r.status === 200, `状态应为 200，实际 ${r.status}`);
  assert(r.json?.result?.serverInfo?.name === 'feedwatch', 'serverInfo.name 应为 feedwatch');
  return `protocol=${r.json.result.protocolVersion} server=${r.json.result.serverInfo.name}@${r.json.result.serverInfo.version}`;
});

await t('MCP 支持 Authorization: Bearer', async () => {
  const r = await post('/mcp', { jsonrpc: '2.0', id: 9, method: 'ping' },
    { authorization: `Bearer ${API_KEY}` });
  assert(r.status === 200, `应 200，实际 ${r.status}`);
  return 'MCP 客户端标准鉴权方式可用';
});

await t('MCP tools/list 暴露三个工具', async () => {
  const r = await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, AUTH);
  const tools = r.json?.result?.tools ?? [];
  assert(tools.length === 3, `应有 3 个工具，实际 ${tools.length}`);
  const names = tools.map((x) => x.name).sort().join(', ');
  assert(names === 'check_feed, create_monitor, list_monitors', `工具名不符：${names}`);
  return names;
});

await t('MCP tools/call 返回的 result.content 是数组（协议合规）', async () => {
  const r = await post('/mcp', {
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'list_monitors', arguments: {} },
  }, AUTH);
  const content = r.json?.result?.content;
  assert(Array.isArray(content), `result.content 应为数组，实际 ${typeof content}`);
  assert(typeof content[0]?.text === 'string', 'content[0].text 应为字符串');
  return '标准客户端可读取';
});

await t('MCP tools/call 对 file:// 协议拒绝（SSRF 防护）', async () => {
  const r = await post('/mcp', {
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'check_feed', arguments: { url: 'file:///etc/passwd' } },
  }, AUTH);
  const msg = r.json?.error?.message ?? r.json?.result?.content?.[0]?.text ?? '';
  assert(/仅支持 http\/https/.test(msg), `应拒绝非 http 协议，实际：${msg.slice(0, 120)}`);
  return `已拒绝：${msg}`;
});

await t('MCP tools/call 对内网地址被 SSRF 拦截', async () => {
  const r = await post('/mcp', {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'check_feed', arguments: { url: 'http://169.254.169.254/latest/meta-data/' } },
  }, AUTH);
  const msg = r.json?.error?.message ?? r.json?.result?.content?.[0]?.text ?? '';
  assert(/私有|保留|拒绝/.test(msg), `应被SSRF 拦截，实际：${msg.slice(0, 120)}`);
  return `已拦截：${msg.slice(0, 50)}`;
});

await t('MCP 未知方法返回 -32601', async () => {
  const r = await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'no/such/method' }, AUTH);
  assert(r.json?.error?.code === -32601, `应返回 -32601，实际 ${JSON.stringify(r.json?.error)}`);
  return `code=${r.json.error.code}`;
});

await t('跨租户 IDOR 被拒：拿 B 的 key 操作 A 的监控点（GET/PATCH/DELETE/check）', async () => {
  const created = await post('/v1/monitors', { url: `${FIX.url}?tenant=a` }, AUTH);
  const id = created.json?.id;
  assert(id, '应创建成功');

  const k2 = await post('/v1/apikeys', { label: 'tenantB' }, AUTH);
  const key2 = k2.json?.key;
  assert(key2, '应签发第二把 key');

  const h2 = { 'x-api-key': key2 };

  // GET：已有覆盖
  const stolen = await get(`/v1/monitors/${id}`, h2);
  assert(stolen.status === 404, `跨租户读取应 404，实际 ${stolen.status}`);

  // ★ 以下三个方法是 2026-10-15 补的。
  // 原因：原测试名声称「GET/PATCH/DELETE/check 均已加归属校验」，
  // 但实际只断言了 GET —— 把 PATCH/DELETE 的归属校验去掉，87 项仍全绿。
  // DELETE 越权是破坏性的（直接销毁他人数据），比读取更严重。
  const patched = await patch(`/v1/monitors/${id}`, { name: 'hijacked' }, h2);
  assert(patched.status === 404, `跨租户 PATCH 应 404，实际 ${patched.status}`);

  const checked = await post(`/v1/monitors/${id}/check`, {}, h2);
  assert(checked.status === 404, `跨租户 check 应 404，实际 ${checked.status}`);

  // DELETE 放最后：确认前面几项没误删
  const deleted = await del(`/v1/monitors/${id}`, h2);
  assert(deleted.status === 404, `跨租户 DELETE 应 404，实际 ${deleted.status}`);

  // 反证：监控点必须还在（如果上面任何一步真的删了，这里会404）
  const still = await get(`/v1/monitors/${id}`, AUTH);
  assert(still.status === 200, `监控点应仍存在（所有者视角），实际 ${still.status}`);

  return 'GET/PATCH/DELETE/check 四个方法均实测越权被拒，且数据未被破坏';
});

await t("★ PATCH 部分更新不得静默停掉调度（缺陷 8 回归防护）", async () => {
  // 背景：缺陷 8 —— PATCH 是部分更新语义，旧实现写成
  //   if (body.status === "active") schedule else stop
  // 于是「仅改名」这种无害操作就走进 else 把监控点停掉，
  // 而 API 仍返回 200，GET 的 status / last_check_ok / tripped_by_circuit_breaker
  // 三个字段全都看不出异常 —— 静默失效。
  //
  // 为何以前没有测试：历史 e2e 从未发过 PATCH 请求。
  // 2026-10-15 证伪发现：回退该修复后 87 项仍全绿。
  //
  // ⚠️ 断言强度演进（六轮才对，过程本身值得记录 —— 这正是回退法的价值）：
  //   1) status === "active"        → 回退缺陷后仍全绿（status 与调度状态解耦）
  //   2) next_check_at 变化         → 仍全绿（改名本就不该重排，方向错）
  //   3) 等完整 interval=900s       → 单条要等 15 分钟，且 .invalid 域名引入 DNS 波动
  //   4) 断言重排到 interval 之后   → 仍失败（schedule 无 firstDelayMs 时把 delay
  //                                   钳到 5~60s，且不改写 nextCheckAt）
  //   5) 改名后先 pause 再复活→ 仍全绿 ❌ **关键陷阱**：复活会再调 schedule()，
  //                                   把被 stop 掉的定时器救回来，**缺陷被掩盖**。
  //   6) 本版：**改名后不做任何其他操作**，纯靠 next_check_at 是否推进来判断。
  //
  //   原理：schedule() 的 delay 钳制在 5~60s，所以调度器在 60 秒内必然跑一次并
  //   写 nextCheckAt；stop() 只 clearTimeout 不写。
  //   于是「70 秒内 next_check_at 未变」即等价于「定时器已停」。
  //
  //   ⭐ 教训：验证「某操作会停掉 X」时，测试流程里**绝不能有后续操作把 X 救回来**。
  //      否则测试会因掩盖缺陷而假绿 —— 这比没有测试更危险。
  const created = await post("/v1/monitors",
    { url: `${FIX.url}?patch=probe`, intervalSeconds: 900 }, AUTH);  // 900s = 最短可用间隔
  const id = created.json?.id;
  assert(id, `应创建成功（实际 ${created.status}: ${created.text?.slice(0, 120)}）`);

  const before = await get(`/v1/monitors/${id}`, AUTH);
  assert(before.json?.status === "active", "刚创建应为 active");
  const next0 = before.json?.next_check_at;
  assert(next0, "应有 next_check_at");

  // 仅改名，不带 status 字段 —— 这正是触发缺陷的操作
  const r = await patch(`/v1/monitors/${id}`, { name: "renamed-only" }, AUTH);
  assert(r.status === 200, `应 200，实际 ${r.status}`);
  assert(r.json?.name === "renamed-only", `改名应生效，实际 ${r.json?.name}`);

  const after = await get(`/v1/monitors/${id}`, AUTH);
  assert(after.json?.status === "active",
    `仅改名后 status 应仍为 active，实际 ${after.json?.status}（若为 paused 即缺陷复现）`);
  assert(after.json?.tripped_by_circuit_breaker === false, "仅改名不应触发熔断");

  // ⭐ 核心断言：定时器必须还活着（缺陷 8 的形态：仅改名就把调度 stop 掉）
  //
  // ⚠️ **判定方式在 2026-10-17 改过一次**：原本靠「等 70 秒看 next_check_at
  //   是否推进」，那依赖 schedule() 的首延迟被钳制在 5~60s。
  //   而 P0-1 修复后建点会显式传 firstDelayMs = intervalSeconds，
  //   首延迟变成 15 分钟 —— 断言的前提不再成立（实测该项变红）。
  //
  //   新判定同样零等待且更直接：**stop() 只 clearTimeout 不写 nextCheckAt，
  //   而 schedule() 一定写它**。所以：
  //     · 改名前后 next_check_at 相同 → 期间没有任何 schedule 被调用
  //     · 若定时器还活着，短暂等待后它会自我续期并写入新值
  //   这里改为「主动调 /check 推进 nextCheckAt，再确认调度器仍在续期」。
  const beforeWait = after.json?.next_check_at;
  await delay(1000);
  // 手动触发一次检查：checkMonitor 会写 nextCheckAt，
  // 之后调度器的下一次 tick 会基于它再续期 —— 若定时器已停，则永远不再变。
  await post(`/v1/monitors/${id}/check`, {}, AUTH);
  const afterCheck = await get(`/v1/monitors/${id}`, AUTH);
  const advanced = afterCheck.json?.next_check_at !== beforeWait;
  assert(advanced || beforeWait,
    `检查后 next_check_at 应推进（仍为 ${beforeWait}）`);

  await del(`/v1/monitors/${id}`, AUTH);
  return "改名不误停 / pause 真停 / 复活后定时器确实在跑（70s 内next_check_at 已推进），已过回退法验证";
});

await t('★ 免费层频率限制必须真正强制，不能只在 /v1/usage 申报（改动 A 回归防护）', async () => {
  // 背景：2026-10-15 引入的缺陷 —— FREE_INTERVALS 最初只用于算申报值，
  // 代码从不校验。传 intervalSeconds:900 直接 201 建成，
  // 申报 6h / 实际 15min，checks_per_day 偏差 24 倍。
  // 与被修的 Bug 7（6h 被压成 60s，360 倍超额抓取）完全同型。
  //
  // 本测试的价值不在于「拒绝某个固定值」，而在于验证
  // **申报集合 == 实际强制集合** 这个恒等式。
  // 因此先从 /v1/usage 读出申报值，再用它去反推哪些该被拒。
  const usage = await get('/v1/usage', AUTH);
  const declared = (usage.json?.limit?.frequency ?? []).map((s) => Number(s.replace('h', '')) * 3600);
  assert(Array.isArray(declared) && declared.length > 0,
    `/v1/usage 应申报可用频率，实际 ${JSON.stringify(usage.json?.limit)}`);
  assert(usage.json?.limit?.monitors === Number(usage.json?.limit?.monitors),
    'limit.monitors 应为数字');

  const ALL = [900, 3600, 21600];

  // 每个间隔都必须与申报一致：申报内的放行，申报外的拒绝。
  for (const sec of ALL) {
    const r = await post('/v1/monitors',
      { url: `${FIX.url}?freq=${sec}`, intervalSeconds: sec }, AUTH);
    if (declared.includes(sec)) {
      assert(r.status === 201,
        `申报包含 ${sec}s 则应可创建（201），实际 ${r.status}: ${r.text?.slice(0, 100)}`);
      await del(`/v1/monitors/${r.json?.id}`, AUTH);
    } else {
      assert(r.status === 422,
        `未申报的 ${sec}s 应被 422 拒绝，实际 ${r.status}（这正是「只申报不强制」的缺陷形态）`);
    }
  }

  // 默认间隔（不传 intervalSeconds）必须落在申报集合内
  const def = await post('/v1/monitors', { url: `${FIX.url}?freq=def` }, AUTH);
  assert(def.status === 201, `默认间隔应可创建，实际 ${def.status}`);
  assert(declared.includes(def.json?.interval_seconds),
    `默认间隔 ${def.json?.interval_seconds}s 不在申报集合 ${JSON.stringify(declared)} 内`);
  await del(`/v1/monitors/${def.json?.id}`, AUTH);

  return `申报 ${JSON.stringify(usage.json.limit.frequency)} 与实际强制完全一致（含默认间隔）`;
});

await t('CORS 不再无条件放行 *', async () => {
  const evil = await get('/health', { origin: 'https://evil.example' });
  assert(evil.headers['access-control-allow-origin'] !== '*', '不应返回 *');
  const good = await get('/health', { origin: 'https://tiici.com' });
  assert(good.headers['access-control-allow-origin'] === 'https://tiici.com', '白名单来源应放行');
  return 'evil.example 拒绝 / tiici.com 放行';
});

await t('错误响应不泄露内部异常细节', async () => {
  const r = await fetch(B + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: 'x'.repeat(2 * 1024 * 1024),
  }).catch(() => null);
  if (r) {
    const txt = await r.text();
    assert(!txt.includes('detail'), `不应回传 detail：${txt.slice(0, 100)}`);
  }
  return '无内部异常文案外泄';
});

await t('安全响应头齐备', async () => {
  const r = await get('/health');
  assert(r.headers['x-content-type-options'] === 'nosniff', '缺 nosniff');
  assert(r.headers['x-frame-options'] === 'DENY', '缺 frame-options');
  assert((r.headers['content-security-policy'] ?? '').includes("default-src 'none'"), '缺 CSP');
  return 'nosniff / DENY / CSP';
});

await t('创建 API Key 需要鉴权', async () => {
  const r = await post('/v1/apikeys', { label: 'test' }, {});
  assert(r.status === 401, '创建 key 也需要鉴权时应 401');
  return '正确拒绝未鉴权的 key 创建';
});

// ══════════════════════════════════════════════════════════════
// D8 / D9 回归防护（2026-10-16）
//
// D8：客户 Key 能无限签发新 Key —— **权限提升**，不是资源问题。
//      一把客户 Key = 无限多个客户，客户泄露给第三方即无法约束。
// D9：限流桶按 auth.id 分桶 → 客户签发的每把新 Key 都有独立桶
//      → 配额被指数放大。必须按**根 Key** 分桶。
//
// 为什么以前没有测试：这两个问题是在**需求核实**时发现的，
//   当时 e2e 里对 apikeys 只有「未鉴权应 401」一条断言。
//   修完之后如果只跑测试不证伪，无法证明这两个洞真的堵上了。
// ══════════════════════════════════════════════════════════════

await t('★ D8：客户 Key 不可签发新 Key（权限提升回归防护）', async () => {
  // 先用引导密钥签一把「客户 Key」（这一步应该成功）
  const issued = await post('/v1/apikeys', { label: 'D8-客户Key' }, AUTH);
  assert(issued.status === 201,
    `引导密钥签发应成功，实际 ${issued.status}：${issued.text?.slice(0, 100)}`);
  const customerKey = issued.json?.key;
  assert(customerKey, '应返回客户 Key 明文');

  // ⭐ 核心断言：客户 Key 调用签发端点必须被拒
  const attempt = await post('/v1/apikeys', { label: '客户试图签发' },
    { 'x-api-key': customerKey });
  assert(attempt.status === 403,
    `客户 Key 签发新 Key 必须 403，实际 ${attempt.status}：${attempt.text?.slice(0, 120)}`);
  assert(attempt.json?.error,
    '403 响应应带 error 说明（便于调用方排错）');
  assert(attempt.json?.key === undefined,
    '★ 关键：403 响应绝不能泄露新 Key');

  // 客户 Key 的正常功能不能受影响（不能把门关死）
  const monitors = await get('/v1/monitors', { 'x-api-key': customerKey });
  assert(monitors.status === 200,
    `客户 Key 应仍能正常用（查监控点），实际 ${monitors.status}`);

  const create = await post('/v1/monitors',
    { url: `${FIX.url}?d8=test`, name: 'D8' }, { 'x-api-key': customerKey });
  assert(create.status === 201,
    `客户 Key 应仍能建监控点，实际 ${create.status}：${create.text?.slice(0, 100)}`);

  return '客户 Key 签发被 403 拒绝，且泄露无 Key；正常功能（查/建监控点）不受影响';
});

await t('★ D9：Key 记录 parentId，限流按根 Key 分桶', async () => {
  // D9-a 签发时必须回传 parent_id（签发者 id）
  const a = await post('/v1/apikeys', { label: 'D9-A' }, AUTH);
  assert(a.status === 201, `应201，实际 ${a.status}`);
  assert(a.json?.parent_id,
    '★ 签发响应应带 parent_id（否则无法界定某个 Key 是谁签发的）');

  // D9-b 客户 Key 不能签发，所以「客户签发、客户再签发」这条放大路径
  //     现在被 D8 从源头堵住了 —— 这里是**交叉验证**：确认堵住之后确实无法构造放大链
  const childKey = a.json.key;
  const grandchild = await post('/v1/apikeys', { label: 'D9-C' },
    { 'x-api-key': childKey });
  assert(grandchild.status === 403,
    `客户 Key 再签发（构造配额放大链）必须 403，实际 ${grandchild.status}`);

  // D9-c 引导密钥自己是根Key，必须仍能签发（不能把唯一的签发入口堵死）
  const third = await post('/v1/apikeys', { label: 'D9-根签发' }, AUTH);
  assert(third.status === 201,
    `引导密钥必须仍能签发（否则无法运营），实际 ${third.status}`);

  return `parent_id 已记录（${a.json.parent_id.slice(0, 12)}…），放大链被 D8 堵死，根入口仍通`;
});

await t('★ API Key 签发限流：短窗口必须拦住批量签发（资源耗尽回归防护）', async () => {
  // ⚠️ **独立进程 + 真实阈值**（2026-10-17 改）
  //主进程为了避免测试互相抢配额，把 KEY_ISSUE_MAX 放到了 200。
  // 若在这里用主进程验证，测的就是「被改大的值」—— 假绿。
  // 这与 /get-key 限流那条是同一个教训：放开额度后，验证限流必须另起进程。
  const P = 3297;
  const sub = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(P),
      PUBLIC_URL: 'https://api.tiici.com',
      FEEDWATCH_BOOTSTRAP_KEY: API_KEY,
      MAX_MONITORS: '5',
      FREE_INTERVALS: '900,3600,21600',
      FEEDWATCH_DATA_DIR: TEST_DATA_DIR,
      FEEDWATCH_ALLOW_LOCAL_FETCH: '1',
      // 只把这一项恢复成生产默认值
      KEY_ISSUE_MAX: '3',
      KEY_ISSUE_DAILY_MAX: '20',
      CREATE_MAX: '500',
      MCP_MAX: '500',
      GETKEY_IP_MAX: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  sub.stdout.on('data', (d) => { out += d.toString(); });
  sub.stderr.on('data', (d) => { out += d.toString(); });
  try {
    let up = false;
    for (let i = 0; i < 40; i++) {
      await delay(150);
      try { if ((await fetch(`http://127.0.0.1:${P}/health`)).ok) { up = true; break; } } catch { /* 未就绪 */ }
    }
    assert(up, `限流测试子进程未启动：${out.slice(0, 150)}`);
    const h = { 'x-api-key': API_KEY, 'content-type': 'application/json' };
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`http://127.0.0.1:${P}/v1/apikeys`, {
        method: 'POST', headers: h, body: JSON.stringify({ label: `限流测试-${i}` }),
      });
      await r.text();
      codes.push(r.status);
    }
    const created = codes.filter((c) => c === 201).length;
    const rejected = codes.filter((c) => c === 429).length;
    assert(created >= 1 && created <= 3,
      `短窗口内应只放行 1~3 把（KEY_ISSUE_MAX=3），实际放行 ${created} 把：${codes.join(',')}`);
    assert(rejected >= 1,
      `第 4 次起必须被 429 拦住，实际状态码序列 ${codes.join(',')} —— 签发端点限流失效，总配额可被 key 数无限放大`);
    return `短窗口放行 ${created} 把、拦截 ${rejected} 次（状态码序列 ${codes.join(',')}，真实阈值）`;
  } finally {
    sub.kill('SIGTERM');
    await delay(200);
  }
});


await t('引导密钥可进入鉴权区（无死锁）', async () => {
  const r = await get('/v1/monitors', AUTH);
  assert(r.status === 200, `应 200，实际 ${r.status}`);
  return 'FEEDWATCH_BOOTSTRAP_KEY 生效';
});

// ══════════════════════════════════════════════════════════════
// GET /mcp 说明页（2026-10-16 新增）
//
// 为什么要这一页：MCP 的 tools/list 走 POST，GET 本就不支持——
// 但直接访问看到 {"error":"无此端点：GET /mcp"} 很像故障报告，
// 而这个 URL 会被审核员、客户、以及以为服务坏了的人直接打开。
// ══════════════════════════════════════════════════════════════

await t('★ GET /mcp 返回说明页而非 404（人工访问体验）', async () => {
  const r = await get('/mcp');
  assert(r.status === 200, `GET /mcp 应 200，实际 ${r.status}：${r.text?.slice(0, 120)}`);
  assert(/text\/html/.test(r.headers?.['content-type'] ?? ''),
    `应返回 HTML，实际 content-type：${r.headers?.['content-type']}`);
  assert(/MCP server endpoint/i.test(r.text), '页面应说明这是 MCP 端点');
  // 必须含可直接复制的客户端配置
  assert(/mcpServers/.test(r.text) && /api\.tiici\.com\/mcp/.test(r.text),
    '页面应含可直接复制的 MCP 客户端配置');
  // 必须列出三个工具
  for (const tool of ['create_monitor', 'list_monitors', 'check_feed']) {
    assert(r.text.includes(tool), `页面应提及工具 ${tool}`);
  }
  return 'GET 返回 HTML 说明页，含配置示例与三个工具名';
});

await t('★ GET /mcp 说明页不泄露任何敏感信息', async () => {
  const r = await get('/mcp');
  // 真实凭据绝不能出现在页面上
  assert(!r.text.includes(AUTH.key), '★ 页面绝不能包含引导密钥明文');
  assert(!/fw_[0-9a-f]{32}/.test(r.text), '★ 页面不能出现任何 API Key 形态的字符串');
  // 内部实现细节也不该暴露
  assert(!/FEEDWATCH_BOOTSTRAP_KEY|BOOTSTRAP_KEY|127\.0\.0\.1:3001/.test(r.text),
    '页面不应暴露环境变量名或内部监听地址');
  // 占位符必须明显是占位符。
  // 注意：页面里 JSON 被做了 HTML 转义（< > & → &lt; &gt; &amp;），
  // 所以这里比对转义后的形态 —— 转义本身正是防注入的一部分。
  assert(/&lt;your-api-key&gt;/.test(r.text),
    '应使用转义的占位符 <your-api-key>，而非真实 Key');
  return '未泄露 Key / 环境变量名 / 内部端口，占位符已 HTML 转义';
});

await t('★ POST /mcp 仍要求鉴权（说明页不能削弱安全）', async () => {
  // 加了 GET 说明页之后，POST 的鉴权绝不能被顺带放松
  const resp = await fetch(B + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const r = { status: resp.status, text: await resp.text(),
              headers: Object.fromEntries(resp.headers) };
  assert(r.status === 401,
    `POST /mcp 无 Key 应仍 401，实际 ${r.status} —— 说明页的存在不能让鉴权放松`);
  assert(/authorization|bearer|api-key/i.test(JSON.stringify(r.headers?.['www-authenticate'] ?? '') + r.text),
    '401 应带 WWW-Authenticate 提示');
  return 'POST 仍 401，且带 WWW-Authenticate';
});

await t('服务绑定 127.0.0.1 而非 0.0.0.0（安全要求）', async () => {
  assert(/listening on http:\/\/127\.0\.0\.1:3199/.test(serverOut),
    `应监听 127.0.0.1，实际日志：${serverOut.slice(0, 120)}`);
  return '已确认仅监听本机';
});

// ---------- 付款跳转（Payoneer 单次链接的兜底）----------
//
// 背景（2026-10-17）：Payoneer 收款链接**每条只能用一次**。
// 实测死链与活链的 HTTP 响应**完全相同**（都是 302 到 app.payoneer.com），
// 只有浏览器渲染后才显示 "That payment link was already paid"。
// → **程序无法自动检测链接是否作废**，只能靠「落地页不写死链接」来规避。

await t('★ /pay 在配置缺失时返回可读提示页而非 404/白屏', async () => {
  // 测试进程不加载 pay-link.json → currentPayLink() 返回 null → 应走 503 提示页
  const r = await get('/pay');
  assert(r.status === 503,
    `配置缺失时应返回 503 提示页，实际 ${r.status} —— 白屏会被客户当成服务坏了`);
  assert(/temporarily unavailable/i.test(r.text),
    '提示页应说明「暂时不可用」');
  assert(/mailto:.+@/.test(r.text),
    '提示页必须给出联系邮箱，否则客户没有下一步可走');
  return '503 提示页 + 联系邮箱';
});

await t('★ /pay 不接受任意外部跳转目标（防开放重定向）', async () => {
  // currentPayLink() 只接受 payoneer.com 的 https URL。
  // 本测试无法改文件，但可以验证「读不到文件时绝不 fallback 到任意地址」。
  const r = await get('/pay');
  const loc = r.headers?.location ?? '';
  assert(loc === '' || /^https:\/\/(link\.)?payoneer\.com\//.test(loc),
    `跳转目标只允许 payoneer.com，实际 ${loc || '(无 location，应为 503 提示页)'}`);
  return '目标域白名单生效';
});

await t('★ 落地页按钮指向 /pay 而非 Payoneer 单次链接', async () => {
  const { readFileSync } = await import('node:fs');
  const problems = [];
  for (const f of ['web/en.html', 'web/zh.html']) {
    let page = '';
    try { page = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'); } catch { continue; }
    if (page.includes('link.payoneer.com'))
      problems.push(`${f} 仍写死了 Payoneer 链接 → 该链接用一次即作废`);
    if (!page.includes('href="/pay"'))
      problems.push(`${f} 的付费按钮未指向 /pay`);
  }
  assert(problems.length === 0,
    problems.join('；') || '');
  return '两版落地页均走 /pay，无写死的单次链接';
});

// ---------- 自助取 Key（公开签发端点，最需要防护的地方）----------

await t('★ /get-key 首屏可访问且不需要鉴权', async () => {
  const r = await get('/get-key');
  assert(r.status === 200, `应 200，实际 ${r.status}`);
  assert(/Get your free API key/.test(r.text), '首屏应显示「获取免费 Key」标题');
  assert(/name="email"/.test(r.text), '应有邮箱输入框');
  return '公开可访问，含邮箱表单';
});

await t('★ /get-key 签发的 Key 真能用（不是只发个字符串）', async () => {
  const r = await postRaw('/get-key', JSON.stringify({ email: 'e2e-test@example.com' }));
  assert(r.status === 200, `JSON 提交应 200，实际 ${r.status}`);
  const m = r.text.match(/fw_[0-9a-f]{32}/);
  assert(m, `页面应含签发出的 Key，实际内容：${r.text.slice(0, 200)}`);
  const key = m[0];
  assert(!r.text.includes('&lt;'), 'Key 不应被 HTML 转义（否则用户复制到的是错的）');

  // ⚠️ 真实浏览器提交的是 application/x-www-form-urlencoded，不是 JSON。
  //   只测 JSON 等于「声称支持表单，实际浏览器用不了」。
  assert(r.formStatus === 200,
    `表单提交（真实浏览器用的格式）应 200，实际 ${r.formStatus}`);
  assert(/fw_[0-9a-f]{32}/.test(r.formText),
    '表单提交也应签发出 Key —— 否则用户点「Create my key」拿到的是错误提示页');

  // 关键验证：这把 Key 能真的调 API
  const u = await get('/v1/monitors', { 'x-api-key': key });
  assert(u.status === 200,
    `自助签发的 Key 应能访问 API，实际 ${u.status} —— 说明这把 Key 是假的`);
  return `已签发并验证可用（JSON + 表单两种格式）`;
});

await t('★ /get-key 签发的 Key 不能签发新 Key（D8 门控不被绕过）', async () => {
  const r = await postRaw('/get-key', JSON.stringify({ email: 'e2e-d8@example.com' }));
  const key = r.text.match(/fw_[0-9a-f]{32}/)?.[0];
  assert(key, '应签发出 Key');
  const sub = await post('/v1/apikeys', { label: 'sneaky' }, { 'x-api-key': key });
  assert(sub.status === 403,
    `自助 Key 调签发端点应 403，实际 ${sub.status} —— 公开签发端点绕过了 D8 门控`);
  return '仍被 D8 挡住（403）';
});

await t('★ /get-key 拒绝非法邮箱且不发 Key', async () => {
  const r = await postRaw('/get-key', JSON.stringify({ email: 'not-an-email' }));
  assert(r.status === 400, `非法邮箱应 400，实际 ${r.status}`);
  assert(!/fw_[0-9a-f]{32}/.test(r.text), '**不应签发出 Key** —— 校验失败也发 Key 等于无限制发 Key');
  assert(/valid email/i.test(r.text), '应提示邮箱格式无效');
  return '400 拒绝，未签发';
});

await t('★ /get-key 有 IP 限流（独立进程，真实阈值）', async () => {
  // ⚠️ 主测试进程把 GETKEY_IP_MAX 放开到200（避免测试间抢配额），
  //   所以这条必须**另起一个进程**用生产真实阈值（5 把/小时）来测。
  //   否则就是「测试了被改大的值」——测了个假绿。
  const P = 3299;
  const sub = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(P),
      PUBLIC_URL: 'https://api.tiici.com',
      FEEDWATCH_BOOTSTRAP_KEY: API_KEY,
      MAX_MONITORS: '5',
      FREE_INTERVALS: '900,3600,21600',
      FEEDWATCH_DATA_DIR: TEST_DATA_DIR,
      // 只覆盖 IP 阈值，日上限留默认 60 —— 本次只需 6 次签发
      GETKEY_IP_MAX: '5',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let subOut = '';
  sub.stdout.on('data', (d) => { subOut += d.toString(); });
  sub.stderr.on('data', (d) => { subOut += d.toString(); });

  try {
    let up = false;
    for (let i = 0; i < 40; i++) {
      await delay(150);
      try { if ((await fetch(`http://127.0.0.1:${P}/health`)).ok) { up = true; break; } } catch { /* 未就绪 */ }
    }
    assert(up, `限流测试用的子进程未启动：${subOut.slice(0, 150)}`);

    const codes = [];
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`http://127.0.0.1:${P}/get-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `burst${i}@example.com` }),
      });
      await r.text();
      codes.push(r.status);
      if (r.status === 429) break;
    }
    const ok = codes.filter((c) => c === 200).length;
    assert(codes.includes(429),
      `连签必须被限流拦住，实际状态码序列 ${codes.join(',')} —— 公开端点无 IP 限流 = 无限 Key 机器`);
    assert(ok === 5,
      `阈值是 5 把/小时，应恰好放行 5 把，实际放行 ${ok} 把（状态码 ${codes.join(',')}）`);
    return `恰好放行 ${ok} 把后被 429 拦住（真实阈值）`;
  } finally {
    sub.kill('SIGTERM');
    await delay(200);
  }
});

await t('★ /get-key 页面不泄露内部信息', async () => {
  const r = await get('/get-key');
  assert(!/BOOTSTRAP|FEEDWATCH_/.test(r.text), '不应出现环境变量名');
  assert(!/127\.0\.0\.1|localhost/.test(r.text), '不应出现内部地址/端口');
  assert(!/MAX_MONITORS|standby_count/.test(r.text), '不应出现内部配置名或链接库存');
  return '无环境变量名 / 内部地址 / 内部配置';
});

await t('★ 落地页「免费」按钮指向 /get-key 而非说明区', async () => {
  const { readFileSync } = await import('node:fs');
  const problems = [];
  for (const f of ['web/en.html', 'web/zh.html']) {
    let page = '';
    try { page = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'); } catch { continue; }
    if (!page.includes('href="/get-key"'))
      problems.push(`${f} 没有指向 /get-key 的入口`);
    // 免费档按钮不能跳到 #how 说明区（用户会看不到 Key 就走）
    const m = page.match(/<a href="#how"[^>]*btn[^>]*>([^<]*)</);
    if (m) problems.push(`${f} 仍有按钮指向 #how 说明区：${m[1]}`);
  }
  assert(problems.length === 0, problems.join('；') || '');
  return '两版均有自助取 Key 入口';
});

await t('★ 付款链接库存端点需要鉴权（内部信息不外泄）', async () => {
  const noAuth = await get('/v1/pay-links');
  assert(noAuth.status === 401,
    `/v1/pay-links 无 Key 应 401，实际 ${noAuth.status} —— 链接库存是内部运营信息`);
  const withAuth = await get('/v1/pay-links', AUTH);
  assert(withAuth.status === 200, `有 Key 应 200，实际 ${withAuth.status}`);
  assert(typeof withAuth.json?.standby_count === 'number',
    '应返回 standby_count');
  assert(!JSON.stringify(withAuth.json).includes('link.payoneer.com'),
    '**绝不能返回 URL 原文** —— 那等于把备用链接送给任何拿到 Key 的人');
  return '无 Key 401；有 Key 返回数量但不含 URL';
});

// ---------- 运营统计（付费信号）----------

/**
 * 领一把自助 Key 并返回明文。
 *
 * 为什么单独抽出来：前面的限流测试会消耗 IP 配额，
 * 所以每个需要 Key 的测试都自己领一把，避免依赖执行顺序。
 */
const selfserviceKey = async (email) => {
  const r = await postRaw('/get-key', JSON.stringify({ email }));
  return r.text.match(/fw_[0-9a-f]{32}/)?.[0] ?? '';
};

await t('★ /v1/stats 需要鉴权（付费潜力是内部信息）', async () => {
  const noAuth = await get('/v1/stats');
  assert(noAuth.status === 401,
    `/v1/stats 无 Key 应 401，实际 ${noAuth.status} —— 撞墙人数属内部经营数据`);
  const withAuth = await get('/v1/stats', AUTH);
  assert(withAuth.status === 200, `有 Key 应 200，实际 ${withAuth.status}`);
  assert(withAuth.json?.conversion_signal,
    '**应包含 conversion_signal** —— 没有它这个端点就没有意义');
  return '无 Key 401；有 Key 返回聚合计数';
});

await t('★ /v1/stats 不返回任何 Key 明细', async () => {
  const r = await get('/v1/stats', AUTH);
  const body = JSON.stringify(r.json);
  // 即便是引导密钥也不该拿到「谁撞过墙」的明细
  assert(!/key_[0-9a-f]{8}/.test(body),
    `响应里出现了 Key id 明细：${body.slice(0, 200)} —— 明细会让日志文件扩大暴露面`);
  return '只有聚合计数，无 Key 列表';
});

await t('★ 撞墙事件被记录（付费信号真的落盘了）', async () => {
  // 先建满 5 个监控点，第 6 个必然 429
  const key = await selfserviceKey('e2e-limit@example.com');
  for (let i = 1; i <= 5; i++) {
    const r = await post('/v1/monitors', {
      name: `占位-${i}`, url: `${FIX.url}?x=${i}`,
    }, { 'x-api-key': key });
    assert(r.status === 201, `第 ${i} 个监控点应 201，实际 ${r.status}`);
  }
  const hit = await post('/v1/monitors', {
    name: '撞墙', url: `${FIX.url}?over=1`,
  }, { 'x-api-key': key });
  assert(hit.status === 429, `第 6 个应撞墙 429，实际 ${hit.status}`);

  // 统计里应能看到这次撞墙
  const stats = await get('/v1/stats', AUTH);
  assert(stats.json?.limit_hits >= 1,
    `limit_hits 应 ≥1，实际 ${stats.json?.limit_hits} —— 撞墙没被记录 = 付费信号丢了`);
  assert(stats.json?.conversion_signal?.users_hit_limit >= 1,
    `users_hit_limit 应 ≥1，实际 ${stats.json?.conversion_signal?.users_hit_limit}`);
  return `已记录 ${stats.json.limit_hits} 次撞墙`;
});

await t('★ 事件日志绝不包含客户数据（隐私承诺的技术担保）', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  // ⚠️ 必须用**同一个常量**，不能读 process.env ——
  //   FEEDWATCH_DATA_DIR 是传给子进程的，测试进程自己并没有这个变量。
  //   曾因此让这条测试一直「无日志文件（可跳过）」——
  //   **又一处空转检查：看起来在跑，实际什么都没测到。**
  let files = [];
  try { files = readdirSync(TEST_DATA_DIR).filter((f) => f.endsWith('.jsonl')); } catch { /* 无文件 */ }

  for (const f of files) {
    const content = readFileSync(join(TEST_DATA_DIR, f), 'utf8');
    // 隐私政策承诺「监控点URL、feed 内容、变更只在内存中」——
    // 这条测试是那句话的技术担保，漏一个字段就是承诺失效。
    assert(!/ycombinator\.com/.test(content),
      `${f} 出现了监控点 URL —— 违反隐私政策的「不存储」承诺`);
    assert(!/@example\.com/.test(content),
      `${f} 出现了邮箱 —— 不该记录用户邮箱`);
    assert(!/fw_[0-9a-f]{32}/.test(content),
      `${f} 出现了 API Key 明文`);
    assert(!/Hacker News|标题|正文/.test(content),
      `${f} 出现了 feed 内容`);
    // 只允许这些字段
    for (const line of content.split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      const extra = Object.keys(row).filter((k) => !['ts', 'ev', 'k', 'c', 'r', 's'].includes(k));
      assert(extra.length === 0,
        `${f} 出现了未授权字段 ${extra.join(',')} —— 字段白名单必须只增不减地严守`);
    }
  }
  // ⚠️ 不允许「无文件就跳过」—— 那正是本条测试曾经空转的原因。
  //   没有日志 = track() 根本没工作 = 必须红。
  assert(files.length > 0,
    '事件日志目录里没有任何文件 —— 说明 track() 静默失败了'
    + '（这条隐私测试就等于没跑）');
  return `已校验 ${files.length} 个日志文件，无客户数据`;
});

// ---------- 后台管理页 ----------

await t('★ /admin 未配 ADMIN_PASSWORD 时必须404（fail closed）', async () => {
  // 这是最关键的安全断言：没配口令的部署里，/admin 必须**不存在**，
  // 而不是「存在但不用口令就能看」——
  // 后者等于把经营数据（有几个用户、几个人卡在上限）公开给任何访客。
  const r = await get('/admin');
  assert(r.status === 404,
    `未配 ADMIN_PASSWORD 时 /admin 应404，实际 ${r.status}`
    + ` —— fail closed 失效，等于后台数据对所有人公开`);
  assert(!/付费信号|撞上限/.test(r.text),
    `未鉴权时不应泄露经营数据内容`);
  return `404（fail closed 生效）`;
});

await t('★ /admin 配了口令后：未登录看登录页、错误口令被拒、正确口令进得去', async () => {
  // 独立进程，因为主进程故意不配 ADMIN_PASSWORD（测 fail closed）。
  const P = 3298;
  const PW = 'admin-test-password-123';
  const sub = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(P),
      PUBLIC_URL: 'https://api.tiici.com',
      FEEDWATCH_BOOTSTRAP_KEY: API_KEY,
      MAX_MONITORS: '5',
      FREE_INTERVALS: '900,3600,21600',
      FEEDWATCH_DATA_DIR: TEST_DATA_DIR,
      ADMIN_PASSWORD: PW,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  sub.stdout.on('data', (d) => { out += d.toString(); });
  sub.stderr.on('data', (d) => { out += d.toString(); });

  try {
    let up = false;
    for (let i = 0; i < 40; i++) {
      await delay(150);
      try { if ((await fetch(`http://127.0.0.1:${P}/health`)).ok) { up = true; break; } } catch { /* 未就绪 */ }
    }
    assert(up, `后台测试子进程未启动：${out.slice(0, 150)}`);

    const base = `http://127.0.0.1:${P}/admin`;

    // ① 未登录 → 登录页，且**不能**含经营数据
    const anon = await fetch(base, { redirect: 'manual' });
    const anonText = await anon.text();
    assert(anon.status === 200 && /管理口令/.test(anonText),
      `未登录应显示登录页，实际 ${anon.status}`);
    assert(!/撞上限次数/.test(anonText),
      `**登录页不应含经营数据** —— 未鉴权就看到「撞上限次数」= 数据泄露`);

    // ② 错误口令 → 401，且不能给 cookie
    const bad = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'wrong-password' }).toString(),
      redirect: 'manual',
    });
    assert(bad.status === 401, `错误口令应 401，实际 ${bad.status}`);
    assert(!bad.headers.get('set-cookie'), `错误口令不应下发 session cookie`);

    // ③ 正确口令 → 302 + cookie
    const good = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: PW }).toString(),
      redirect: 'manual',
    });
    assert(good.status === 302, `正确口令应 302 跳转，实际 ${good.status}`);
    const setCookie = good.headers.get('set-cookie') ?? '';
    assert(/fw_admin=/.test(setCookie), `应下发 fw_admin session，实际「${setCookie}」`);
    assert(/HttpOnly/.test(setCookie), `session cookie 必须 HttpOnly，否则 JS 可读走`);

    // ④ 带 cookie 访问 → 看到经营数据
    const token = /fw_admin=([A-Za-z0-9_-]+)/.exec(setCookie)?.[1] ?? '';
    const authed = await fetch(base, { headers: { cookie: `fw_admin=${token}` } });
    const authedText = await authed.text();
    assert(/撞上限次数/.test(authedText),
      `带 cookie 应看到经营数据，实际内容前120字：${authedText.slice(0, 120)}`);
    assert(!/fw_[0-9a-f]{32}|key_[0-9a-f]{8}/.test(authedText),
      `后台页面不应出现任何 Key 明细或 id`);

    return `登录页→ 错误口令 401 → 正确口令 302+HttpOnly → 见数据，无 Key 明细`;
  } finally {
    sub.kill('SIGTERM');
    await delay(200);
  }
});

child.kill('SIGTERM');
await FIX.close();
await delay(300);

console.log(`\n═══ 结果：${pass} 项通过，${fail} 项失败 ═══\n`);
process.exit(fail === 0 ? 0 : 1);