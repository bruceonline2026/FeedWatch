/**
 * 自测脚本：验证三大核心能力
 *  1. 三协议解析
 *  2. 字段级 diff（含"修改已有条目"——这是核心差异化）
 *  3. SSRF 防护
 *
 * 运行：node scripts/selftest.js
 */

import { detectAndParse, parseRss, parseAtom, parseJsonFeed } from '../src/parser/feeds.js';
import { Snapshot, diffSnapshots } from '../src/diff/engine.js';
import { isPrivateAddress, assertHttpUrl } from '../src/security/ssrf.js';

let pass = 0, fail = 0;
const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    pass++; results.push(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    fail++; results.push(`  ✗ ${name} — ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

console.log('\n═══ FeedWatch MVP 自测 ═══\n');

/* ---------- 1. 三协议解析 ---------- */
console.log('【1】三协议解析');

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Test Feed</title>
  <link>https://example.com</link>
  <item>
    <title>First post</title>
    <link>https://example.com/1</link>
    <guid>post-1</guid>
    <pubDate>Mon, 12 Oct 2026 00:00:00 GMT</pubDate>
    <description>Original body text.</description>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Test</title>
  <entry>
    <title>Atom entry one</title>
    <link rel="alternate" href="https://example.org/a1"/>
    <id>urn:uuid:1</id>
    <updated>2026-10-12T00:00:00Z</updated>
    <content type="html">Atom body content.</content>
  </entry>
</feed>`;

const JSONFEED = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'JSON Feed Test',
  items: [
    { id: 'j1', url: 'https://json.example/j1', title: 'JSON item', content_text: 'JSON body.', date_published: '2026-10-12T00:00:00Z' },
  ],
});

check('RSS 2.0 解析', () => {
  const r = parseRss(RSS);
  assert(r.format === 'rss', 'format 应为 rss');
  assert(r.items.length === 1, `应解析出 1 条，实际 ${r.items.length}`);
  assert(r.items[0].id === 'post-1', `id 应为 post-1，实际 ${r.items[0].id}`);
  assert(r.items[0].title === 'First post', `title 应为 First post，实际 "${r.items[0].title}"`);
  assert(r.items[0].contentText === 'Original body text.', `正文解析异常: "${r.items[0].contentText}"`);
  return `${r.items.length} 条, id=${r.items[0].id}`;
});

check('Atom 1.0 解析', () => {
  const r = parseAtom(ATOM);
  assert(r.format === 'atom', 'format 应为 atom');
  assert(r.items.length === 1, `应解析出 1 条，实际 ${r.items.length}`);
  assert(r.items[0].link === 'https://example.org/a1', `link 解析错误: ${r.items[0].link}`);
  assert(r.items[0].id === 'urn:uuid:1', `id 错误: ${r.items[0].id}`);
  return `${r.items.length} 条, link=${r.items[0].link}`;
});

check('JSON Feed 解析', () => {
  const r = parseJsonFeed(JSONFEED);
  assert(r.format === 'jsonfeed', 'format 应为 jsonfeed');
  assert(r.items.length === 1, `应解析出 1 条，实际 ${r.items.length}`);
  assert(r.items[0].id === 'j1', `id 错误: ${r.items[0].id}`);
  return `${r.items.length} 条, id=${r.items[0].id}`;
});

check('协议自动识别', () => {
  const a = detectAndParse(RSS).format;
  const b = detectAndParse(ATOM).format;
  const c = detectAndParse(JSONFEED, 'application/json').format;
  assert(a === 'rss' && b === 'atom' && c === 'jsonfeed', `识别错误: ${a}/${b}/${c}`);
  return `RSS→${a} Atom→${b} JSON→${c}`;
});

/* ---------- 2. 字段级 diff ---------- */
console.log('\n【2】字段级 diff（核心差异化能力）');

const snapV1 = new Snapshot('https://x/feed', parseRss(RSS), '2026-10-12T00:00:00Z');

// 版本2：标题被修正 + 新增一条
const RSS_V2 = RSS
  .replace('<title>First post</title>', '<title>First post (corrected)</title>')
  .replace('</channel>', `<item>
    <title>Second post</title><link>https://example.com/2</link><guid>post-2</guid>
    <pubDate>Tue, 13 Oct 2026 00:00:00 GMT</pubDate>
    <description>New body.</description></item></channel>`);

const snapV2 = new Snapshot('https://x/feed', parseRss(RSS_V2), '2026-10-13T00:00:00Z');

check('首次检查：全部视为新增', () => {
  const d = diffSnapshots(null, snapV1);
  assert(d.changed === true, '应判定为有变化');
  assert(d.reason === 'first_check', `reason 应为 first_check，实际 ${d.reason}`);
  assert(d.changes.length === 1 && d.changes[0].type === 'added', '应有 1 条 added');
  return `${d.changes.length} 条新增`;
});

check('无变化时哈希粗筛短路（成本关键）', () => {
  const same = new Snapshot('https://x/feed', parseRss(RSS), '2026-10-13T00:00:00Z');
  const d = diffSnapshots(snapV1, same);
  assert(d.changed === false, '应判定为无变化');
  assert(d.reason === 'hash_match', `应走哈希短路，实际 ${d.reason}`);
  assert(d.changes.length === 0, '不应有变更条目');
  return 'O(1) 短路，未做逐条计算';
});

check('★ 检测到「已有条目被修改」+ 字段级 diff', () => {
  const d = diffSnapshots(snapV1, snapV2);
  assert(d.changed === true, '应判定为有变化');

  const mod = d.changes.find((c) => c.type === 'modified');
  assert(mod, '★ 应检测到 modified 类型变更（这是竞品普遍做不到的）');
  assert(mod.item_id === 'post-1', `应命中 post-1，实际 ${mod.item_id}`);

  const titleDiff = mod.diff.find((x) => x.field === 'title');
  assert(titleDiff, '应产出 title 字段级差异');
  assert(titleDiff.old === 'First post', `old 值错误: "${titleDiff.old}"`);
  assert(titleDiff.new === 'First post (corrected)', `new 值错误: "${titleDiff.new}"`);

  const added = d.changes.find((c) => c.type === 'added');
  assert(added?.item_id === 'post-2', '应同时检测到新增 post-2');

  return `modified(post-1, title: "${titleDiff.old}" → "${titleDiff.new}") + added(post-2)`;
});

check('删除检测', () => {
  const RSS_V3 = RSS.replace(/<item>[\s\S]*?<\/item>/, '');
  const snapV3 = new Snapshot('https://x/feed', parseRss(RSS_V3), '2026-10-14T00:00:00Z');
  const d = diffSnapshots(snapV2, snapV3);
  const removed = d.changes.filter((c) => c.type === 'removed');
  assert(removed.length === 2, `应检测到 2 条删除，实际 ${removed.length}`);
  return `${removed.length} 条删除`;
});

check('HTML 差异不会被误判为内容变化', () => {
  const a = parseRss(`<rss version="2.0"><channel><title>t</title><item><guid>x</guid><title>T</title><description>&lt;p&gt;Hello&lt;/p&gt;</description></item></channel></rss>`);
  const b = parseRss(`<rss version="2.0"><channel><title>t</title><item><guid>x</guid><title>T</title><description>  <p>Hello</p>  </description></item></channel></rss>`);
  const s1 = new Snapshot('u', a, 'x'), s2 = new Snapshot('u', b, 'y');
  const d = diffSnapshots(s1, s2);
  assert(d.changed === false, 'HTML 标签与空白差异应被归一化，不应误报');
  return '标签与空白已归一化';
});

/* ---------- 3. SSRF 防护 ---------- */
console.log('\n【3】SSRF 防护（P0 安全项）');

const PRIVATE_IPS = ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1'];
const PUBLIC_IPS = ['8.8.8.8', '1.1.1.1', '93.184.216.34'];

check('私有网段与云元数据地址全部拦截', () => {
  const blocked = PRIVATE_IPS.filter((ip) => isPrivateAddress(ip));
  assert(blocked.length === PRIVATE_IPS.length,
    `应全部拦截，实际拦截 ${blocked.length}/${PRIVATE_IPS.length}，漏: ${PRIVATE_IPS.filter((i) => !isPrivateAddress(i))}`);
  return `${blocked.length}/${PRIVATE_IPS.length} 全部拦截（含 169.254.169.254 元数据地址）`;
});

check('公网 IP 正常放行', () => {
  const passed = PUBLIC_IPS.filter((ip) => !isPrivateAddress(ip));
  assert(passed.length === PUBLIC_IPS.length, `公网 IP 被误拦: ${PUBLIC_IPS.filter((i) => isPrivateAddress(i))}`);
  return `${passed.length}/${PUBLIC_IPS.length} 正常放行`;
});

check('非 http/https 协议拒绝', () => {
  const bad = ['file:///etc/passwd', 'gopher://x', 'ftp://x', 'file://etc/passwd'];
  let rejected = 0;
  for (const u of bad) {
    try { assertHttpUrl(u); } catch { rejected++; }
  }
  assert(rejected === bad.length, `应全部拒绝，实际拒绝 ${rejected}/${bad.length}`);
  return `${rejected} 种危险协议全部拒绝`;
});

check('URL 内嵌凭据拒绝', () => {
  try { assertHttpUrl('https://user:pass@example.com/feed'); throw new Error('未拒绝'); }
  catch (e) { assert(e.message.includes('认证信息'), '应提示认证信息问题'); }
  return 'user:pass@ 形式已拒绝';
});

/* ---------- 汇总 ---------- */
console.log('\n' + results.join('\n'));
console.log(`\n═══ 结果：${pass} 项通过，${fail} 项失败 ═══\n`);
process.exit(fail === 0 ? 0 : 1);