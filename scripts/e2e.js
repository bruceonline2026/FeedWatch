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

await t('★ API Key 签发限流：短窗口必须拦住批量签发（资源耗尽回归防护）', async () => {
  // 背景（2026-07-15 补）：POST /v1/apikeys 此前**完全无限流**，
  // 实测 20 次调用签发 20 把 key 全成功（31ms）。
  // 危险在于配额是 per-key 的 —— key 数无上限意味着
  // 总配额 = MAX_MONITORS × key 数，内存监控点与出网流量都能无限放大。
  //
  // 为什么以前没有测试：这条路径只在实测时被想起来，
  // e2e 里对 apikeys 的断言只有「未鉴权应401」一条。
  //
  // 用法约束：默认配置是 3 把/分钟，短窗口就是本次测试要撞的那道墙。
  // 所以本测试消耗的是引导密钥自己的配额桶（每测试进程独立，互不影响）。
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const r = await post('/v1/apikeys', { label: `限流测试-${i}` }, AUTH);
    codes.push(r.status);
  }

  const created = codes.filter((c) => c === 201).length;
  const rejected = codes.filter((c) => c === 429).length;

  assert(created >= 1 && created <= 3,
    `短窗口内应只放行 1~3 把（默认 KEY_ISSUE_MAX=3），实际放行 ${created} 把：${codes.join(',')}`);
  assert(rejected >= 1,
    `第 4 次起必须被 429 拦住，实际状态码序列 ${codes.join(',')} —— 签发端点限流失效，总配额可被 key 数无限放大`);
  assert(codes.every((c) => c === 201 || c === 429),
    `只应出现 201/429，实际 ${codes.join(',')}（出现其他状态码说明逻辑异常）`);

  // 被拒的响应必须带明确指引，而不是裸错误
  const last = await post('/v1/apikeys', { label: '限流测试-追加' }, AUTH);
  if (last.status === 429) {
    assert(last.json?.retry_after_seconds,
      '429 响应应带 retry_after_seconds，让调用方知道等多久');
  }

  return `短窗口放行 ${created} 把、拦截 ${rejected} 次（状态码序列 ${codes.join(',')}）`;
});

await t('引导密钥可进入鉴权区（无死锁）', async () => {
  const r = await get('/v1/monitors', AUTH);
  assert(r.status === 200, `应 200，实际 ${r.status}`);
  return 'FEEDWATCH_BOOTSTRAP_KEY 生效';
});

await t('服务绑定 127.0.0.1 而非 0.0.0.0（安全要求）', async () => {
  assert(/listening on http:\/\/127\.0\.0\.1:3199/.test(serverOut),
    `应监听 127.0.0.1，实际日志：${serverOut.slice(0, 120)}`);
  return '已确认仅监听本机';
});

child.kill('SIGTERM');
await delay(300);

console.log(`\n═══ 结果：${pass} 项通过，${fail} 项失败 ═══\n`);
process.exit(fail === 0 ? 0 : 1);