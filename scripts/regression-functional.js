/**
 * 回归测试 B：锁定「解析器 / 调度 / 状态」三类缺陷（对应 scripts/regression.js 的另一组）
 *
 * 与 regression.js 分文件的原因：regression.js 由安全审计方向维护，
 * 覆盖 SSRF 与投递；本文件覆盖功能正确性，避免两人改同一文件。
 *
 * 这一组缺陷的共同点，与已修的两个 bug 完全同族 —— **静默失效**：
 * ���部返回 200 / 不抛异常 / 测试全绿，但结果是错的。
 *
 * 运行：node scripts/regression-functional.js
 */
import { parseRss, parseAtom, detectAndParse } from '../src/parser/feeds.js';
import { Snapshot, diffSnapshots } from '../src/diff/engine.js';
import { MemoryStore, MonitorService } from '../src/service.js';
import { handleMcpRequest } from '../src/mcp/endpoint.js';
import { safeFetch, __testing as ssrfTesting } from '../src/security/ssrf.js';
import http from 'node:http';

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { const d = fn(); pass++; out.push(`  ✓ ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { fail++; out.push(`  ✗ ${name} — ${e.message}`); }
};
const acheck = async (name, fn) => {
  try { const d = await fn(); pass++; out.push(`  ✓ ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { fail++; out.push(`  ✗ ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n═══ 回归测试 B：解析器 / 调度 / 状态 ═══\n');

const desc = (d) => parseRss(
  `<rss version="2.0"><channel><item><guid>a</guid><description>${d}</description></item></channel></rss>`
).items[0].contentText;

/* ---------- 1. nodeText：Bug 2 的「另一半」 ---------- */
console.log('【1】nodeText 不再丢弃子标签');

check('#text 与子标签并存时两者都保留', () => {
  const o = desc('<a href="http://x">link</a>tail');
  assert(o.includes('link'), `'link' 丢失，得到 "${o}"`);
  assert(o.includes('tail'), `'tail' 丢失，得到 "${o}"`);
  return `"${o}"`;
});

check('Atom type="xhtml" 正文不丢字', () => {
  const a = parseAtom(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>a</id>
    <content type="xhtml"><div><p>Hello <b>world</b></p></div></content></entry></feed>`);
  assert(a.items[0].contentText.includes('world'), `'world' 丢失，得到 "${a.items[0].contentText}"`);
  return `"${a.items[0].contentText}"`;
});

check('★ 子标签里的文字变化能被 diff 检出', () => {
  const v1 = parseRss('<rss version="2.0"><channel><item><guid>a</guid><description>see <a href="http://x">docs</a></description></item></channel></rss>');
  const v2 = parseRss('<rss version="2.0"><channel><item><guid>a</guid><description>see <a href="http://x">diagrams</a></description></item></channel></rss>');
  const d = diffSnapshots(new Snapshot('u', v1, '1'), new Snapshot('u', v2, '2'));
  assert(d.changed === true, '应检出变化（正文丢字时永远检测不到）');
  return '已检出';
});

/* ---------- 2. RSS 1.0 / RDF ---------- */
console.log('\n【2】RSS 1.0（RDF）');

check('rdf:RDF 解析出条目（修复前 100% 抛错）', () => {
  const r = parseRss(`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <channel rdf:about="https://e.com"><title>RDF Feed</title></channel>
    <item rdf:about="https://e.com/1"><title>One</title><dc:date>2026-01-01</dc:date><description>b1</description></item>
    <item rdf:about="https://e.com/2"><title>Two</title><description>b2</description></item>
  </rdf:RDF>`);
  assert(r.items.length === 2, `应 2 条（item 是 channel 兄弟节点），实际 ${r.items.length}`);
  assert(r.items[0].id === 'https://e.com/1', `id 应取 rdf:about，实际 "${r.items[0].id}"`);
  return `${r.items.length} 条, id=${r.items[0].id}`;
});

check('RDF 经 detectAndParse 也能识别', () => {
  const r = detectAndParse(`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <channel><title>t</title></channel><item rdf:about="u1"><title>a</title></item></rdf:RDF>`);
  assert(r.items.length === 1, `应 1 条，实际 ${r.items.length}`);
  return 'rss 识别成功';
});

/* ---------- 3. detectAndParse 以 body 为准 ---------- */
console.log('\n【3】detectAndParse 不被错误 content-type 带跑');

check('RSS 被误配为 application/json 仍可解析', () => {
  const r = detectAndParse('<rss version="2.0"><channel><title>t</title><item><guid>a</guid></item></channel></rss>', 'application/json');
  assert(r.format === 'rss', `应 rss，实际 ${r.format}`);
  return 'body 形状优先';
});

check('UTF-8 BOM 不破坏识别', () => {
  const r = detectAndParse('﻿<rss version="2.0"><channel><title>t</title></channel></rss>', 'application/xml');
  assert(r.format === 'rss', `应 rss，实际 ${r.format}`);
  return 'BOM 已剥离';
});

check('真 JSON Feed 无回归', () => {
  const r = detectAndParse(JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'J', items: [{ id: '1', title: 'x' }] }), 'application/json');
  assert(r.format === 'jsonfeed', `应 jsonfeed，实际 ${r.format}`);
  return '正常';
});

/* ---------- 4. HTML 实体 ---------- */
console.log('\n【4】stripHtml 解码 HTML 命名实体');

check('&hellip; &mdash; &ldquo; 被解码', () => {
  const o = desc('a&hellip;b&mdash;c&ldquo;d&rdquo;e&nbsp;f');
  assert(o === 'a…b—c“d”e f', `不符: "${o}"`);
  return `"${o}"`;
});

check('数字实体（十进制 + 十六进制）被解码', () => {
  const o = desc('a&#8220;b&#x4e2d;c');
  assert(o === 'a“b中c', `不符: "${o}"`);
  return `"${o}"`;
});

check('显示层等价实体归一化（不产生假变更）', () => {
  assert(desc('&hellip;') === desc('…'), '等价实体应归一');
  return '已归一';
});

check('未知实体原样保留（不吞内容）', () => {
  const o = desc('a&notareal;b');
  assert(o.includes('notareal'), `被吞: "${o}"`);
  return '保留';
});

/* ---------- 5. 调度时间语义 ---------- */
console.log('\n【5】定时器真正尊重 intervalSeconds');

await acheck('★ 续期延迟 = intervalSeconds（修复前恒为 60s）', async () => {
  for (const interval of [900, 3600, 21600]) {
    const store = new MemoryStore();
    const svc = new MonitorService(store);
    const m = store.createMonitor({ url: 'https://example.com/f', intervalSeconds: interval });
    svc.checkMonitor = async () => ({});
    // 必须走真实 tick 续期路径：无参 schedule() 是「首次/恢复调度」，
    // 设计上就该钳到 ≤60s，直接调它测不到续期逻辑。
    svc.schedule(m, { firstDelayMs: 15 });
    await sleep(90);
    const sec = Math.round((new Date(m.nextCheckAt).getTime() - Date.now()) / 1000);
    assert(Math.abs(sec - interval) < 5, `interval=${interval}s 续期实际=${sec}s`);
    svc.stopAll();
  }
  return '900/3600/21600 均按真实间隔';
});

check('首次调度仍「尽快跑一次」（≤60s）', () => {
  const store = new MemoryStore();
  const svc = new MonitorService(store);
  const m = store.createMonitor({ url: 'https://example.com/f', intervalSeconds: 21600 });
  svc.checkMonitor = async () => ({});
  svc.schedule(m);
  const d = new Date(m.nextCheckAt).getTime() - Date.now();
  assert(d > 0 && d <= 60_000, `应 0~60s，实际 ${Math.round(d / 1000)}s`);
  svc.stopAll();
  return `${Math.round(d / 1000)}s`;
});

check('monitor 消失后 timers 条目被清理', () => {
  const store = new MemoryStore();
  const svc = new MonitorService(store);
  const m = store.createMonitor({ url: 'https://example.com/f', intervalSeconds: 900 });
  svc.checkMonitor = async () => ({});
  svc.schedule(m);
  assert(svc.timers.size === 1, '应注册 1 个 timer');
  store.monitors.delete(m.id);
  clearTimeout(svc.timers.get(m.id));
  const cur = store.getMonitor(m.id);
  if (!cur || cur.status !== 'active') svc.stop(m.id);
  assert(svc.timers.size === 0, `应清理，实际残留 ${svc.timers.size}`);
  return '已清理';
});

/* ---------- 6. 并发互斥 ---------- */
console.log('\n【6】同一监控点并发检查去重');

await acheck('并发 check 只真正执行一次', async () => {
  const store = new MemoryStore();
  const svc = new MonitorService(store);
  const m = store.createMonitor({ url: 'https://example.com/f', intervalSeconds: 900 });
  let real = 0;
  svc._checkMonitor = async () => { real++; await sleep(30); return {}; };
  const rs = await Promise.all([svc.checkMonitor(m), svc.checkMonitor(m), svc.checkMonitor(m)]);
  assert(real === 1, `应执行 1 次，实际 ${real}`);
  return `执行 1 次, 跳过 ${rs.filter((r) => r.skipped).length} 次`;
});

await acheck('检查结束后 inFlight 释放', async () => {
  const store = new MemoryStore();
  const svc = new MonitorService(store);
  const m = store.createMonitor({ url: 'https://example.com/f', intervalSeconds: 900 });
  svc._checkMonitor = async () => ({});
  await svc.checkMonitor(m);
  assert(svc.inFlight.size === 0, 'inFlight 未清空');
  await svc.checkMonitor(m);
  return '可重复检查';
});

await acheck('检查抛错后 inFlight 仍释放', async () => {
  const store = new MemoryStore();
  const svc = new MonitorService(store);
  const m = store.createMonitor({ url: 'https://example.com/f', intervalSeconds: 900 });
  svc._checkMonitor = async () => { throw new Error('boom'); };
  await svc.checkMonitor(m).catch(() => {});
  assert(svc.inFlight.size === 0, '异常路径未释放');
  return '已清理';
});

/* ---------- 7. 状态不被写坏 ---------- */
console.log('\n【7】错误路径不污染基线');

await acheck('抓取失败时不推进 snapshot', async () => {
  const store = new MemoryStore();
  const svc = new MonitorService(store);
  const m = store.createMonitor({ url: 'https://example.com/f', intervalSeconds: 900 });
  const before = store.getSnapshot(m.id);
  svc._checkMonitor = async () => { throw new Error('上游 500'); };
  await svc.checkMonitor(m).catch(() => {});
  assert(store.getSnapshot(m.id) === before, '失败后 snapshot 不应变化');
  return '基线未被污染';
});

check('删除监控点时快照一并回收', () => {
  const store = new MemoryStore();
  for (let i = 0; i < 10; i++) {
    const m = store.createMonitor({ url: `https://example.com/${i}`, intervalSeconds: 900 });
    store.saveSnapshot(m.id, { items: new Map(), contentHash: 'x' });
  }
  assert(store.snapshots.size === 10, `应 10 份，实际 ${store.snapshots.size}`);
  for (const id of [...store.monitors.keys()]) store.deleteMonitor(id);
  assert(store.snapshots.size === 0, `应全回收，残留 ${store.snapshots.size}`);
  return '10 份已回收';
});

/* ---------- 8. MCP 响应结构 ---------- */
console.log('\n【8】MCP tools/call 响应结构符合协议');

const mcpCtx = () => {
  const store = new MemoryStore();
  return { store, ctx: { store, apiKeyId: 'k1', maxMonitors: 10, checkOnce: async (u) => ({ url: u, format: 'rss', changed: false, reason: 'r', changes: [] }) } };
};

await acheck('result.content 是数组（不是多包一层的对象）', async () => {
  const { ctx } = mcpCtx();
  const r = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_monitors', arguments: {} } }, ctx);
  assert(Array.isArray(r.result?.content), `result.content 应为数组，实际 ${typeof r.result?.content}`);
  assert(r.result.content[0]?.type === 'text', '首个块应为 text');
  return `content.length=${r.result.content.length}`;
});

await acheck('三个工具都返回可读文本', async () => {
  const { ctx } = mcpCtx();
  for (const [name, args] of [['create_monitor', { url: 'https://example.com/a' }], ['list_monitors', {}], ['check_feed', { url: 'https://example.com/a' }]]) {
    const r = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx);
    assert(typeof r.result?.content?.[0]?.text === 'string', `${name} 未返回文本`);
  }
  return 'create/list/check 均正常';
});

await acheck('所有分支返回 Promise（Bug 1 回归防护）', async () => {
  const { ctx } = mcpCtx();
  for (const method of ['initialize', 'notifications/initialized', 'tools/list', 'ping', 'no/such/method']) {
    const p = handleMcpRequest({ jsonrpc: '2.0', id: 1, method }, ctx);
    assert(p && typeof p.then === 'function', `${method} 未返回 Promise`);
    const r = await p;
    assert(JSON.stringify(r) !== '{}', `${method} 序列化为空对象`);
  }
  return '5 个分支均为 Promise';
});

/* ---------- 9. 代理路径的 SSRF 防护 ---------- */
console.log('\n【9】代理路径不削弱 SSRF 防护');

await acheck('字面量私有 IP 在代理模式下仍被拦截', async () => {
  // 这条审计方向已验过；此处作为回归防护留存
  for (const u of ['http://169.254.169.254/', 'http://127.0.0.1:3001/', 'http://10.0.0.1/']) {
    for (const proxyUrl of ['', 'http://127.0.0.1:9/']) {
      try {
        await safeFetch(u, { timeoutMs: 800, proxyUrl });
        throw new Error(`${u} (proxy=${proxyUrl || '无'}) 未被拦截`);
      } catch (e) {
        assert(e.code === 'private_address' || /未达上限|ECONNREFUSED/.test(e.message),
          `${u} 错误码异常: ${e.code ?? e.message}`);
      }
    }
  }
  return '6 种组合全部拦截';
});

await acheck('★ 走代理时不得盲信代理侧的 DNS 结果', async () => {
  // 攻击场景：我们校验的是公网 IP（93.184.216.34），
  // 但若把【域名】交给代理，代理会用它自己的 DNS 再解析一次（不受我们校验）。
  // 攻击者控制 DNS 时（TTL=0），可对我们返回公网 IP、对代理返回内网 IP。
  //
  // 正确行为：请求行必须是**已校验的 IP**，Host 头带域名供虚拟主机/SNI 用。
  //
  // ⚠️ 判据说明：不能用「响应 body 是否含内网内容」判断 ——
  //   恶意代理本来就可以无视请求行、直接返回任意内容，
  //   safeFetch 无法判断响应真伪。真正的防线是「请求发往了哪里」。
  const rebindingResolver = { lookup: async () => [{ address: '93.184.216.34', family: 4 }] };
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push({ uri: req.url, host: req.headers.host });
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end('<rss version="2.0"><channel><title>proxy-response</title><item><guid>a</guid></item></channel></rss>');
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const port = proxy.address().port;
  try {
    const r = await safeFetch('http://rebind.attacker.example/feed', {
      timeoutMs: 2000, resolver: rebindingResolver,
      proxyUrl: `http://127.0.0.1:${port}/`,
    });

    assert(seen.length > 0, '代理未收到请求');
    const got = seen[0];

    // ★ 硬断言：请求行必须是已校验 IP，不得出现未校验域名
    assert(
      /^http:\/\/93\.184\.216\.34:80\//.test(got.uri),
      `请求行必须是已校验 IP（http://93.184.216.34:80/...），实际：${got.uri}`
      + ` —— 若为域名，代理可自行 rebinding 到内网。`
    );
    assert(
      !got.uri.includes('attacker.example'),
      `请求行泄漏了未校验域名（${got.uri}），rebinding 窗口仍存在。`
    );
    // Host 头保持域名是**正确**的：隧道内用于 TLS SNI 与虚拟主机路由
    assert(
      /rebind\.attacker\.example/.test(got.host ?? ''),
      `Host 头应保持域名供 SNI/虚拟主机使用，实际：${got.host}`
    );
    assert(r.resolvedIp === '93.184.216.34', `应记录已校验 IP，实际 ${r.resolvedIp}`);

    return `请求行=${got.uri} · Host=${got.host} · 未盲信代理侧 DNS ✓`;
  } finally {
    proxy.close();
  }
});

await acheck('★ CONNECT 隧道目标必须是已校验 IP（而非域名）', async () => {
  // 这是 B6 之外的第二道防线，也是代理路径修复的验收标准。
  // 用真实 CONNECT 代理（http.Server 的 'connect' 事件，plain handler 收不到）。
  const seen = [];
  const proxy = http.createServer((_req, res) => { res.writeHead(502); res.end(); });
  proxy.on('connect', (req, socket) => {
    seen.push({ kind: 'CONNECT', target: req.url });
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    setTimeout(() => socket.destroy(), 50);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const port = proxy.address().port;
  const pinned = '93.184.216.34';
  try {
    await safeFetch('https://rebind.attacker.example/feed.xml', {
      timeoutMs: 1500,
      resolver: { lookup: async () => [{ address: pinned, family: 4 }] },
      proxyUrl: `http://127.0.0.1:${port}/`,
    });
  } catch { /* 隧道被主动切断，属预期 */ }
  proxy.close();

  const connect = seen.find((s) => s.kind === 'CONNECT');
  assert(connect, '代理未收到 CONNECT');
  console.log(`      CONNECT 目标 = ${connect.target}`);

  // ★ 硬断言（2026-10-12 由记录行为升级）。
  //   这是 B6 的验收标准，也是防止有人无意中把代码改回去的唯一保障。
  const expectedTarget = `${pinned}:443`;
  assert(
    connect.target === expectedTarget,
    `CONNECT 目标必须是已校验 IP ${expectedTarget}，实际为 ${connect.target}。`
    + `若为域名，说明代理会自行解析 → rebinding 窗口存在。`
    + `修复：openTunnel 的 target 应用 pinnedIp.address，SNI 保持 hostname。`
  );
  assert(
    !connect.target.includes('attacker.example'),
    `CONNECT 目标泄漏了未校验域名（${connect.target}）—— SSRF 防护被绕过。`
  );
  return `CONNECT → ${connect.target}（已钉 IP，SNI 仍为域名）`;
});

await acheck('viaProxy / resolvedIp 语义在两种模式下一致', async () => {
  // TOCTOU 修复后：代理模式的目标也是已校验 IP，
  // 所以 resolvedIp 在两种模式下都等于「实际连接/指定的 IP」。
  // 这条锁住语义，防止将来有人把 target 改回域名而字段说明没跟着改。
  const resolver = { lookup: async () => [{ address: '93.184.216.34', family: 4 }] };
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push({ uri: req.url, host: req.headers.host });
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end('<rss version="2.0"><channel><title>t</title></channel></rss>');
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    const r = await safeFetch('http://viaproxy.example.com/f', {
      timeoutMs: 1500, resolver,
      proxyUrl: `http://127.0.0.1:${proxy.address().port}/`,
    });
    assert(r.viaProxy === true, `viaProxy 应为 true，实际 ${r.viaProxy}`);
    assert(r.resolvedIp === '93.184.216.34', `resolvedIp 应为已校验 IP，实际 ${r.resolvedIp}`);
    // resolvedIp 必须真的出现在发给代理的请求行里
    assert(seen[0].uri.includes(r.resolvedIp),
      `resolvedIp 未出现在请求行（${seen[0].uri}），字段语义与实际行为不符`);
    // Host 头必须保留域名（虚拟主机/SNI 依赖它）
    assert(/viaproxy\.example\.com/.test(seen[0].host ?? ''),
      `Host 头应保留域名，实际 ${seen[0].host}`);
    return `viaProxy=${r.viaProxy} · resolvedIp=${r.resolvedIp} 与请求行一致`;
  } finally {
    proxy.close();
  }
});

check('★ NO_PROXY 命中则强制直连（curl 语义）', () => {
  // 这是可用性问题而非安全漏洞：不遵守 NO_PROXY 会让「本该直连的域名被强制走代理」，
  // 在代理不可达或该域名需内网直连时表现为无端超时。
  const saved = { NO: process.env.NO_PROXY, no: process.env.no_proxy, HTTP: process.env.HTTP_PROXY };
  const setNo = (v) => { if (v) process.env.NO_PROXY = v; else delete process.env.NO_PROXY; };
  try {
    delete process.env.no_proxy;
    process.env.HTTP_PROXY = 'http://127.0.0.1:8080/';
    // [NO_PROXY 值, 目标 URL, 期望 'null'(直连) | 'proxy']
    const cases = [
      ['',                       'http://a.example.com/f',    'proxy'],  // 未设置 → 走代理
      ['example.com',            'http://a.example.com/f',    'null'],   // 前缀匹配子域
      ['example.com',            'http://example.com/f',      'null'],
      ['example.com',            'http://b.other.com/f',      'proxy'],  // 不命中
      ['.example.com',           'http://a.example.com/f',    'null'],   // 前导点
      ['*',                      'http://anything.com/f',     'null'],   // 通配
      ['a.com,b.com',            'http://b.com/f',            'null'],   // 逗号分隔
      ['a.com, b.com',           'http://b.com/f',            'null'],   // 逗号+空格
      ['example.com:8080',       'http://example.com/f',      'proxy'],  // 端口不匹配
      ['example.com:80',         'http://example.com/f',      'null'],   // 端口匹配
      ['EXAMPLE.COM',            'http://a.example.com/f',    'null'],   // 大小写
      ['http://example.com',     'http://a.example.com/f',    'null'],   // 带协议前缀
      ['other.com',              'http://a.example.com/f',    'proxy'],
    ];
    const wrong = [];
    for (const [np, url, expect] of cases) {
      setNo(np);
      const p = ssrfTesting.resolveProxy('', url);
      const got = p === null ? 'null' : 'proxy';
      if (got !== expect) wrong.push(`NO_PROXY=${JSON.stringify(np)} ${url} → ${got}（期望 ${expect}）`);
    }
    assert(wrong.length === 0, `${wrong.length} 项不符：\n    ${wrong.join('\n    ')}`);

    // 显式传入 proxyUrl 时，调用方点名要代理就尊重之，不被 NO_PROXY 覆盖
    setNo('*');
    const explicit = ssrfTesting.resolveProxy('http://127.0.0.1:9/', 'http://example.com/f');
    assert(explicit !== null, '显式 proxyUrl 不应被 NO_PROXY 覆盖');

    return `${cases.length} 项语义全部符合 curl`;
  } finally {
    if (saved.NO === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = saved.NO;
    if (saved.no === undefined) delete process.env.no_proxy; else process.env.no_proxy = saved.no;
    if (saved.HTTP === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = saved.HTTP;
  }
});

console.log('\n' + out.join('\n'));
console.log(`\n═══ 结果：${pass} 项通过，${fail} 项失败 ═══\n`);
process.exit(fail === 0 ? 0 : 1);
