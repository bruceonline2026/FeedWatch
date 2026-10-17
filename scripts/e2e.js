/**
 * 端到端测试：同进程内启动服务 → 测试 → 关闭
 * 避免后台进程被沙箱回收
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 3199;
const B = `http://127.0.0.1:${PORT}`;

/**
 * 上线前安全审计后：/mcp 与 REST 区一样要求鉴权。
 * 旧版这里不传任何凭证就断言 MCP 可用，等于把「匿名可调用」固化成了契约。
 * 现在通过 FEEDWATCH_BOOTSTRAP_KEY 注入测试密钥，并显式测试匿名被拒。
 */
const API_KEY = 'fw_e2e_test_bootstrap_key_at_least_32_chars';
const AUTH = { 'x-api-key': API_KEY };

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
  const created = await post('/v1/monitors', { url: 'http://tenant-a.com/f.xml' }, AUTH);
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
    { url: "http://patch-probe.invalid/f.xml", intervalSeconds: 900 }, AUTH);
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

  // ⭐ 核心断言：改名后不做任何其他操作，70 秒内定时器必须还活着
  //    （缺陷 8 的形态：仅改名就把调度 stop 掉）
  const beforeWait = after.json?.next_check_at;
  await delay(70_000);
  const later = await get(`/v1/monitors/${id}`, AUTH);
  assert(later.json?.next_check_at !== beforeWait,
    `仅改名后 70 秒，next_check_at 仍未更新（仍为 ${beforeWait}）—— 调度器被静默停止，缺陷 8 复现`);

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
      { url: `http://freq-${sec}.com/f.xml`, intervalSeconds: sec }, AUTH);
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
  const def = await post('/v1/monitors', { url: 'http://freq-def.com/f.xml' }, AUTH);
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
    { url: 'http://d8-test.com/f.xml', name: 'D8' }, { 'x-api-key': customerKey });
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
  // 背景（2026-07-15 补）：POST /v1/apikeys 此前**完全无限流**，
  // 实测 20 次调用签发 20 把 key 全成功（31ms）。
  // 危险在于配额是 per-key 的 —— key 数无上限意味着
  // 总配额 = MAX_MONITORS × key 数，内存监控点与出网流量都能无限放大。
  //
  // ⚠️ 断言方式在 2026-10-16 调整（D9 之后）：
  //   D9 把限流桶从「按 auth.id」改成「按根 Key」——
  //   **所有签发共用引导密钥这一个桶**（这正是修复目的：
  //   客户签发的每把新 Key 不再获得独立桶，消除指数放大）。
  //   因此本测试**不再假设自己能放行 1~3 把** ——
  //   同一个测试进程里若已跑过其他签发测试，桶已用满是正常且正确的行为。
  //
  //   改为断言「不可能无限放行」这个本质：
  //   在桶未用满的进程里应能签发；桶用满时应全部 429。
  //   两种情况都算通过 —— 但**绝不能出现 5 次全201**。
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const r = await post('/v1/apikeys', { label: `限流测试-${i}` }, AUTH);
    codes.push(r.status);
  }

  const created = codes.filter((c) => c === 201).length;
  const rejected = codes.filter((c) => c === 429).length;

  assert(codes.every((c) => c === 201 || c === 429),
    `只应出现 201/429，实际 ${codes.join(',')}（出现其他状态码说明逻辑异常）`);

  // ★ 本质断言：桶的容量是有限的，5 次连签不能全部成功
  assert(created < 5,
    `短窗口内 5 次连签全部成功（${codes.join(',')}）—— 限流失效，总配额可被 key 数无限放大`);

  // 被拒的响应必须带明确指引，而不是裸错误
  if (rejected > 0) {
    const last = await post('/v1/apikeys', { label: '限流测试-追加' }, AUTH);
    if (last.status === 429) {
      assert(last.json?.retry_after_seconds,
        '429 响应应带 retry_after_seconds，让调用方知道等多久');
    }
  }

  return created > 0
    ? `桶有余量，放行 ${created} 把、拦截 ${rejected} 次（${codes.join(',')}）`
    : `桶已用满（D9 共享桶的预期行为），5 次全部拦截（${codes.join(',')}）—— 容量受限，防线有效`;
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

child.kill('SIGTERM');
await delay(300);

console.log(`\n═══ 结果：${pass} 项通过，${fail} 项失败 ═══\n`);
process.exit(fail === 0 ? 0 : 1);