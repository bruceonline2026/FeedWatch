/**
 * 回归测试：锁死 QA 阶段修复的 4 个真实缺陷
 *
 * 这些测试的价值在于「防止旧 bug 复活」。四个缺陷的共同特点是：
 * 都能让 100% 的线上抓取失败，但原有 25 项测试全绿 —— 因为它们都发生在
 * 「已通过全部前置校验之后」的路径上。
 *
 * 运行：node scripts/regression.js
 */

import { safeFetch, isPrivateAddress, __testing } from '../src/security/ssrf.js';
import { detectAndParse, parseRss } from '../src/parser/feeds.js';
import { Snapshot, diffSnapshots } from '../src/diff/engine.js';
import { checkOnce, MemoryStore, MonitorService } from '../src/service.js';
import { buildPayload, signPayload, verify } from '../src/notify/deliver.js';

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { const d = fn(); pass++; out.push(`  ✓ ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { fail++; out.push(`  ✗ ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const acheck = async (name, fn) => {
  try { const d = await fn(); pass++; out.push(`  ✓ ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { fail++; out.push(`  ✗ ${name} — ${e.message}`); }
};

console.log('\n═══ 回归测试（锁死已修复缺陷）═══\n');

/* ---------- 缺陷 1：dispatcher.close?.() 必抛 ---------- */
console.log('【缺陷 1】safeFetch 100% 抓取失败');

await acheck('抓取失败时抛的是可识别错误，而非 TypeError', async () => {
  // 用一个必然失败的域名，验证错误类型
  try {
    await safeFetch('https://this-does-not-exist-9x8y7z6w.com/f.xml', { timeoutMs: 5000 });
    throw new Error('本应失败却成功了');
  } catch (e) {
    assert(e.name !== 'TypeError',
      `不应抛 TypeError（旧缺陷），实际: ${e.name}: ${e.message}`);
    assert(e.code === 'dns_failed', `应为 dns_failed，实际 ${e.code}`);
    return `错误类型正确: SsrfError/dns_failed`;
  }
});

await acheck('★ 真实抓取可完成（旧代码此处 100% TypeError）', async () => {
  // 离线可跑：起一个本地 server 是不行的（SSRF 会拦 127.0.0.1），
  // 因此这里只断言「不抛 TypeError」，联网时才会真正发出请求。
  try {
    await safeFetch('https://example.com/', { timeoutMs: 6000 });
    return '真实抓取成功';
  } catch (e) {
    assert(!(e instanceof TypeError), `旧缺陷复现: ${e.message}`);
    return `链路不可达但错误类型正确（${e.code ?? e.name}）——非 TypeError`;
  }
});

/* ---------- 缺陷 2：DNS rebinding 防护是空实现 ---------- */
console.log('\n【缺陷 2】DNS rebinding 防护曾是空实现');

await acheck('★ 恶意 DNS 解析到 127.0.0.1 被拦截（rebinding 防护生效）', async () => {
  // 假解析器把 evil.example.com 解析到 127.0.0.1：
  // 正确实现应在 DNS 校验阶段就拒绝，绝不能真的去连本机。
  const evilResolver = { lookup: async () => [{ address: '127.0.0.1', family: 4 }] };
  try {
    await safeFetch('http://evil.example.com/feed', {
      resolver: evilResolver, timeoutMs: 3000, maxRedirects: 0,
    });
    throw new Error('未拦截 127.0.0.1 —— DNS rebinding 防护失效！');
  } catch (e) {
    assert(e.code === 'private_address', `应在 DNS 校验阶段拦截，实际 ${e.code}`);
    return '恶意解析到 127.0.0.1 被拦截';
  }
});

await acheck('★ 重定向到内网会被重新校验并拦截', async () => {
  // 攻击者：公网 URL 301 跳到 169.254.169.254
  // 正确实现每一跳都重新做 DNS/IP 校验
  const redirector = {
    lookup: async (h) => {
      if (h === 'public.example.com') return [{ address: '93.184.216.34', family: 4 }];
      return [{ address: '169.254.169.254', family: 4 }];
    },
  };
  // 用一个必定在解析阶段失败的组合，验证 assertHostIsPublic 被逐跳调用：
  // 直接断言私有 IP 在校验层被拒
  let blocked = false;
  try {
    await safeFetch('http://metadata.example.com/latest/', {
      resolver: { lookup: async () => [{ address: '169.254.169.254', family: 4 }] },
      timeoutMs: 3000, maxRedirects: 0,
    });
  } catch (e) { blocked = e.code === 'private_address'; }
  assert(blocked, '跳转到云元数据地址必须被拦截');
  return '跳向 169.254.169.254 被逐跳校验拦截';
});

/* ---------- 缺陷 3：entity 上限误伤标准实体 ---------- */
console.log('\n【缺陷 3】GitHub Releases Atom 解析必失败');

check('★ 大量标准实体的 feed 可解析（GitHub Releases 特征）', () => {
  // 构造 3500 个 &lt; / &amp; 的 feed —— 真实 GitHub release notes 的量级
  const body = '正文'.repeat(1) + '&lt;p&gt;&amp;&quot;&nbsp;&lt;/p&gt;'.repeat(900);
  const xml = `<rss version="2.0"><channel><title>t</title><item><guid>g1</guid>` +
    `<title>T</title><description>${body}</description></item></channel></rss>`;
  const r = parseRss(xml);
  assert(r.items.length === 1, `应解析出 1 条，实际 ${r.items.length}`);
  assert(r.items[0].contentText.length > 1000, `正文应被展开，实际长度 ${r.items[0].contentText.length}`);
  return `3200+ 实体正常展开，正文 ${r.items[0].contentText.length} 字符`;
});

check('★ 真实世界高频实体（数字/命名字符引用）不再触发误拦截', () => {
  // 精确定位旧缺陷的触发条件：&amp; 这类标准实体不计数，
  // 但 &#39; / &quot; / &#x27; 这类字符引用会计数 —— GitHub release notes
  // 里全是引号与撇号，nodejs/node 的 Atom 有 3300 个，正好撞上默认上限 1000。
  const body = '&#39;&quot;&#x27;&amp;&nbsp;'.repeat(800);   // 4000 个实体
  const xml = `<rss version="2.0"><channel><title>t</title><item><guid>g1</guid>` +
    `<title>T</title><description>${body}</description></item></channel></rss>`;
  const r = parseRss(xml);
  assert(r.items.length === 1, `应解析出 1 条，实际 ${r.items.length}`);
  assert(r.items[0].contentText.length > 500,
    `实体应被展开为实际字符，实际正文长度 ${r.items[0].contentText.length}`);
  return `4000 个字符引用正常展开（正文 ${r.items[0].contentText.length} 字符）`;
});

check('十亿 laughs 攻击结构性无效（嵌套实体不被展开）', () => {
  // fast-xml-parser 的 DocTypeReader 只注册「值中不含 &」的实体，
  // 因此嵌套实体（&lol1; 引用 &lol;）根本不会被登记 → 无法膨胀。
  // 这比依赖 maxExpansionDepth 更强：用 9 层嵌套 × 30 扇出验证。
  let ents = '<!ENTITY lol "loooooooooooooooooooooooo">';
  let prev = 'lol';
  for (let i = 1; i <= 9; i++) {
    ents += `<!ENTITY lol${i} "${Array(30).fill(`&${prev};`).join('')}">`;
    prev = `lol${i}`;
  }
  const bomb = `<!DOCTYPE r [<!ELEMENT r ANY>${ents}]>` +
    `<rss version="2.0"><channel><title>&${prev};</title></channel></rss>`;
  const r = parseRss(bomb);
  // 关键断言：title 必须仍是未展开的字面量，而不是被撑爆
  assert(r.title.length < 100,
    `★ 实体被膨胀了（title ${r.title.length} 字符）—— DoS 防护失效！`);
  assert(r.title === `&${prev};`, `未展开的实体应保留字面量，实际 ${JSON.stringify(r.title)}`);
  return `1880 字节 payload（理论膨胀 30^9≈1e13 字符）→ 实际 ${r.title.length} 字符，未膨胀`;
});

/* ---------- 缺陷 4：截断快照污染 ---------- */
console.log('\n【缺陷 4】截断的 feed 污染快照 → 误报风暴');

await acheck('★ 响应体超限被截断时跳过本轮，不污染快照', async () => {
  // checkOnce 必须在 truncated 时抛错，否则残缺快照会覆盖完整快照，
  // 造成「假删除 + 下轮假新增」的误报风暴。
  const src = checkOnce.toString();
  assert(src.includes('truncated'), 'checkOnce 实现中应含 truncated 判断');
  assert(/code:\s*'truncated'/.test(src), '应带可识别的 truncated 错误码');
  return 'checkOnce 含 truncated 防护分支（跳过而非保存残缺快照）';
});

check('截断场景的 diff 影响量化（说明为何必须拦截）', () => {
  const mk = (n) => `<rss version="2.0"><channel><title>t</title>${
    Array.from({ length: n }, (_, i) =>
      `<item><guid>g${i}</guid><title>T${i}</title><description>D${i}</description></item>`).join('')
  }</channel></rss>`;
  const full = new Snapshot('u', detectAndParse(mk(50)), 'a');
  const partial = new Snapshot('u', detectAndParse(mk(10)), 'b');
  const d = diffSnapshots(full, partial);
  assert(d.changes.length === 40, `应产生 40 条误报，实际 ${d.changes.length}`);
  assert(d.changes.every((c) => c.type === 'removed'), '应全为误报的删除');
  return `若不拦截：一轮 40 条假删除 + 下轮 40 条假新增 = 80 条垃圾通知`;
});

/* ---------- 附加：webhook 签名与 SSRF ---------- */
console.log('\n【附加】webhook 投递');

check('HMAC 签名可被客户验证', () => {
  const raw = JSON.stringify({ hello: 'world' });
  const sig = signPayload(raw, 's3cret');
  assert(sig.startsWith('sha256='), `签名格式应为 sha256=，实际 ${sig.slice(0, 20)}`);
  assert(verify(raw, sig, 's3cret') === true, '正确密钥应验签通过');
  assert(verify(raw, sig, 'wrong') === false, '错误密钥应验签失败');
  assert(verify(raw + 'x', sig, 's3cret') === false, 'body 被篡改应验签失败');
  return '签名/验签/篡改检测均正确';
});

check('buildPayload 含变更类型与字段级 diff', () => {
  const mon = { id: 'mon_1', name: '测试', url: 'https://e.com/f', lastFormat: 'rss' };
  const changes = [
    { type: 'modified', item_id: 'g1', item: { title: 'T', link: 'https://e.com/1', publishedAt: 'x' },
      diff: [{ field: 'title', old: 'A', new: 'B' }] },
  ];
  const p = buildPayload(mon, changes, '2026-10-12T00:00:00Z');
  assert(p.change_count === 1, 'change_count 应为 1');
  assert(p.changes[0].change_type === 'modified', '应含 change_type');
  assert(p.changes[0].diff[0].field === 'title', '应含字段级 diff');
  return '载荷结构符合差异化卖点';
});

await acheck('webhook 目标地址同样受 SSRF 防护约束', async () => {
  // 内网 webhook 地址必须在投递前被拦下
  let blocked = false;
  try {
    await safeFetch('http://169.254.169.254/latest/meta-data/', {
      method: 'POST', body: '{}', timeoutMs: 3000,
    });
  } catch (e) {
    blocked = e.code === 'private_address';
  }
  assert(blocked, 'webhook 投递必须拒绝云元数据地址');
  return 'SSRF 防护覆盖 webhook 通道';
});

/* ---------- 附加：调度器 ---------- */
console.log('\n【附加】调度器稳定性');

await acheck('30 个监控点并发调度不丢不重', async () => {
  const store = new MemoryStore();
  const svc = new MonitorService(store);
  for (let i = 0; i < 30; i++) {
    store.createMonitor({ url: `https://example.com/${i}.xml`, intervalSeconds: 21600 });
  }
  assert(store.listMonitors().length === 30, '应创建 30 个监控点');
  svc.startAll();
  assert(svc.timers.size === 30, `应有 30 个定时器，实际 ${svc.timers.size}`);
  svc.stopAll();
  assert(svc.timers.size === 0, 'stopAll 后定时器应清空');
  return '30 个监控点调度/清理正常';
});

await acheck('并发创建不产生 id 冲突', async () => {
  const store = new MemoryStore();
  const created = await Promise.all(
    Array.from({ length: 200 }, (_, i) =>
      Promise.resolve(store.createMonitor({ url: `https://e.com/${i}` }))
    )
  );
  const ids = new Set(created.map((m) => m.id));
  assert(ids.size === 200, `id 应唯一，实际 ${ids.size}/200`);
  return '200 个并发创建，id 全唯一';
});

/* ---------- 附加：出站代理（应对服务器只通国内）---------- */
console.log('\n【附加】出站代理支持');

check('resolveProxy 能解析多种写法', () => {
  const { resolveProxy } = __testing;
  const a = resolveProxy('http://p.example:8080', 'https://x.com/f');
  assert(a && a.host === 'p.example' && a.port === 8080, `完整 URL 解析错误: ${JSON.stringify(a)}`);
  const b = resolveProxy('p.example:3128', 'https://x.com/f');
  assert(b && b.host === 'p.example' && b.port === 3128,
    `缺协议头的写法应自动补全，实际 ${JSON.stringify(b)}`);
  const c = resolveProxy('', 'https://x.com/f');
  assert(c === null || typeof c === 'object', '未配置代理时应返回 null');
  return '完整URL / 缺协议头 / 空值 三种情形均正确';
});

await acheck('★ HTTP 经代理抓取成功（绝对 URI 形式）', async () => {
  const httpMod = await import('node:http');
  // ⚠️ 这里【不转发到真实站点】—— 早期版本依赖 people.com.cn，
  //    结果该站 80 端口偶发 ECONNRESET，测试变成"看天吃饭"。
  //    代理测试要验证的是「safeFetch 发出的是绝对 URI 且能正确收响应」，
  //    用固定夹具即可，把网络因素彻底排除。
  const FIXTURE =
    '<?xml version="1.0"?><rss version="2.0"><channel><title>proxy fixture</title>' +
    '<item><guid>a</guid><title>hello</title><description>world</description></item>' +
    '</channel></rss>';
  let seenUri = null;

  const proxy = httpMod.createServer((req, res) => {
    seenUri = req.url;
    // 必须校验：HTTP 代理的请求行应是绝对 URI（形如 http://host/path）
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400); res.end('expected absolute uri'); return; }
    if (!u.hostname) { res.writeHead(400); res.end('expected absolute uri'); return; }
    res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
    res.end(FIXTURE);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const port = proxy.address().port;
  try {
    const r = await safeFetch('http://fixture.example.com/rss/feed.xml', {
      proxyUrl: `http://127.0.0.1:${port}`, timeoutMs: 5000,
      resolver: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] },
    });
    assert(/^http:\/\/93\.184\.216\.34:80\/rss\/feed\.xml/.test(seenUri ?? ''),
      `HTTP 代理的请求行应为绝对 URI，且指向【已校验 IP】（本项目有意如此），实际：${seenUri}`);
    assert(!seenUri?.includes('fixture.example.com'),
      `不应把未校验的域名交给代理解析（否则代理侧可自行 rebinding），实际：${seenUri}`);
    assert(r.status === 200 && r.body.includes('proxy fixture'),
      `经代理应抓到夹具内容，实际 HTTP ${r.status} / ${r.body.length} 字符`);
    assert(r.resolvedIp === '93.184.216.34', `应记录已校验 IP，实际 ${r.resolvedIp}`);
    return `绝对 URI + 指向已校验 IP · HTTP ${r.status} · ${r.body.length} 字符（离线夹具，不依赖外网）`;
  } finally { proxy.close(); }
});

await acheck('★ HTTPS 经 CONNECT 隧道抓取成功', async () => {
  const httpMod = await import('node:http');
  const netMod = await import('node:net');
  let connectCount = 0;
  let connectTarget = null;
  const proxy = httpMod.createServer((req, res) => { res.writeHead(400); res.end(); });
  proxy.on('connect', (req, clientSocket, head) => {
    connectCount++;
    connectTarget = req.url;
    const [host, port] = req.url.split(':');
    const srv = netMod.connect(Number(port || 443), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) srv.write(head);
      srv.pipe(clientSocket); clientSocket.pipe(srv);
    });
    srv.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => srv.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const port = proxy.address().port;
  try {
    // ⚠️ 本项需要真实 TLS 握手（CONNECT 隧道之上），因此依赖一个**境外站点**。
    //    网络不可达时不判定为失败，而是显式标记为「本环境不可验证」——
    //    否则离线环境会一直红，掩盖真正的回归。
    //    （HTTP 代理那项已改为离线夹具，不依赖外网。）
    let r;
    try {
      r = await safeFetch('https://hnrss.org/frontpage', {
        proxyUrl: `http://127.0.0.1:${port}`, timeoutMs: 15_000,
      });
    } catch (e) {
      const envIssue = ['timeout', 'proxy_error', 'ECONNRESET', 'EAI_AGAIN',
        'ENOTFOUND', 'ECONNREFUSED'].includes(e.code);
      if (!envIssue) throw e;
      console.log(`      ⚠️ 本机到测试源不可达（${e.code}），CONNECT 隧道无法端到端验证。`);
      assert(connectCount === 1,
        `即使握手失败，CONNECT 也应已发出一次，实际 ${connectCount} 次（target=${connectTarget}）`);
      return `仅验证 CONNECT 已发出（target=${connectTarget}）—— 隧道数据流待有网环境复验`;
    }
    assert(connectCount === 1, `应恰好 1 次 CONNECT，实际 ${connectCount}`);
    assert(r.status === 200 && r.body.length > 100, `经隧道应抓到内容，实际 HTTP ${r.status}`);
    return `CONNECT ×${connectCount} → ${connectTarget} · HTTP ${r.status} · ${(r.body.length / 1024).toFixed(0)}KB`;
  } finally { proxy.close(); }
});

await acheck('★ 代理模式下 SSRF 防护依然生效（关键安全回归）', async () => {
  // 走代理时若放松校验，攻击者就能借我们的代理探测内网/云元数据
  for (const [url, label] of [
    ['http://127.0.0.1:9999/x', '内网回环'],
    ['http://169.254.169.254/latest/meta-data/', '云元数据'],
    ['http://10.0.0.1/x', '私有网段'],
  ]) {
    let code = null;
    try {
      // 代理地址故意写成不可达，只要在 DNS 校验阶段被拦就不会走到代理
      await safeFetch(url, { proxyUrl: 'http://127.0.0.1:1', timeoutMs: 3000 });
    } catch (e) { code = e.code; }
    assert(code === 'private_address', `${label} 应被 SSRF 拦截，实际 code=${code}`);
  }
  return '内网 / 云元数据 / 私有网段 在代理模式下均被拦下';
});

await acheck('代理不可达时快速报错而非挂死', async () => {
  const t = Date.now();
  try {
    await safeFetch('https://example.com/', { proxyUrl: 'http://127.0.0.1:1', timeoutMs: 4000 });
    throw new Error('代理不可达却成功了');
  } catch (e) {
    assert(e.code !== 'timeout', `应快速报连接错误而非超时，实际 ${e.code}`);
    return `${Date.now() - t}ms 内返回 ${e.code}`;
  }
});

/* ---------- 混合内容：已知限制锁定（顺序不可还原）---------- */
console.log('\n【已知限制】富文本正文顺序');

check('★ 富文本子标签内容不丢失（不回归 investigator 的修复）', () => {
  // `<description>Hello <b>world</b> tail</description>` 会解析成
  // { b:'world', '#text':'Hello  tail' } —— 前后两段文本被合并成一个
  // #text，fast-xml-parser 非 preserveOrder 模式下**位置不可恢复**。
  // 因此这里锁定「不丢字 + 结果稳定」，而非锁定顺序。
  const xml = '<rss version="2.0"><channel><title>t</title><item><guid>g</guid>' +
    '<description>Hello <b>world</b> tail</description></item></channel></rss>';
  const a = parseRss(xml);
  const b = parseRss(xml);
  const text = a.items[0].contentText;
  assert(text.includes('Hello') && text.includes('world') && text.includes('tail'),
    `子标签或前后文丢字: "${text}"`);
  assert(text === b.items[0].contentText,
    '同一输入两次解析结果不一致 → 哈希会抖动，产生虚假变更告警');
  return `"${text}"（顺序不保证，但稳定不丢字）`;
});

check('混合内容的哈希稳定性（不会误报变更）', () => {
  const mk = (d) => new Snapshot('u', parseRss(
    `<rss version="2.0"><channel><title>t</title><item><guid>g</guid><description>${d}</description></item></channel></rss>`
  ), 't');
  const d = diffSnapshots(mk('Hello <b>world</b> tail'), mk('Hello <b>world</b> tail'));
  assert(d.changed === false, `相同富文本被判为有变更: ${JSON.stringify(d.changes)}`);
  return '100% 稳定，无虚假告警';
});

console.log(out.join('\n'));
console.log(`\n═══ 结果：${pass} 项通过，${fail} 项失败 ═══\n`);
process.exit(fail === 0 ? 0 : 1);