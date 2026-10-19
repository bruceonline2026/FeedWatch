/**
 * 回归测试：JSON Feed 的 tags 必须能被检出为 category 变化（2026-10-19）
 *
 * ── 要防守的缺陷 ──
 *   `src/parser/feeds.js` 的 `parseJsonFeed` 此前只填 `tags`，从不填 `category`：
 *     extra: { author: ..., tags: toArray(it.tags).join(',') }
 *   而 `src/diff/engine.js` 的 `TRACKED_FIELDS` 追踪的是**统一键** `category`：
 *     ['title','contentText','link','publishedAt','author','category']
 *
 * ── 根因：规范用词差异，不是笔误 ──
 *   · JSON Feed（jsonfeed.org/version/1.1）把该字段叫 `tags` —— 语义是
 *     「作者自拟的自由标签」
 *   · RSS 2.0 / Atom 1.0 把它叫 `category` —— 语义更接近「分类」
 *   两者**并非完全同义**，但引擎只认 `category`，于是 JSON Feed 条目的
 *   `category` 恒为 `undefined`。
 *
 * ── ⚠️ 为什么这个缺陷比「少报一个字段」更严重：它【完全静默】──
 *   ① `Snapshot` 的粗筛哈希只覆盖 TRACKED_FIELDS（engine.js:119-124）：
 *        `String(i.category ?? '')` → `String(undefined ?? '')` → 恒为 `''`
 *      ⇒ 哈希与 tags 变化**完全无关**；
 *   ② `diffSnapshots` 第一层直接 `return { changed:false, reason:'hash_match' }`
 *      （engine.js:166-168）⇒ **逐字段比对 diffItem 根本不进**
 *      ⇒ 不产生 diff 条目、不产生日志、不产生任何提示。
 *
 *   实测（修复前）：
 *     tags `tech,news` → `tech,ai`（真实变化）
 *       → changed=false, reason=hash_match, diff=[]
 *
 *   对照：若哈希层没短路，diffItem 里 `a ?? ''` vs `b ?? ''` 也是 `'' === ''`
 *   —— 即便进了第二层**照样检不出**。两层都失效，不是单点问题。
 *
 * ── 与本family前两个实例的关系 ──
 *   1. `atom:updated` 被整个丢弃
 *   2. `publishedAt` 兜底吃 `updated` → 误标 100%
 *   3. **本条**：JSON Feed `tags` 不写进 `category`
 *   三者同源：**协议层字段与统一字段模型的对齐缺口**，
 *   且都落在「静默」这一侧 —— 不报错、不告警，只是不工作。
 *
 * ── 修法与理由（为何映射而非改 TRACKED_FIELDS）──
 *   选「把 tags 映射过去」：
 *     · 改 TRACKED_FIELDS 成 `tags` 会**削弱 RSS/Atom 的能力**
 *       （它们的这个字段本就叫 category，改了等于让 RSS/Atom 分类变更失检）
 *     · 映射是**加能力**（JSON Feed 也能被追踪），改字段名是**换能力**
 *   且 `tags` 字段本身**保留**：它是JSON Feed 规范的原生字段，
 *   将来若要单独追踪（tags 与 category 语义确实不同），数据已就位。
 *
 * ── 假阳性守卫（用例 3 的重点）──
 *   无 tags 字段时：`toArray(undefined)` → `[]` → `[].join(',')` → `''`
 *   ⇒拿到的是**空串**而非 `undefined`，跨轮次稳定。
 *   ⚠️ 关键区别：`undefined` 与 `''` 在**不同轮次间跳变**会产生假变更；
 *     两个 `''` 相等则不产生 diff —— 后者是对的。
 *   用例 3 显式验证「首轮无键 → 次轮空串」不炸，且连续两轮无 tags 完全静默。
 *
 * 运行：node scripts/json-feed-category-regression.js
 */

import { parseJsonFeed, parseRss, parseAtom } from '../src/parser/feeds.js';
import { Snapshot, diffSnapshots } from '../src/diff/engine.js';

let pass = 0, fail = 0;
const out = [];
const t = async (name, fn) => {
  try { const d = await fn(); pass++; out.push(`  ✓ ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { fail++; out.push(`  ✗ ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

console.log('\n═══ JSON Feed category 回归套件（2026-10-19）═══\n');

/** JSON Feed 样本。tags 传 null 即模拟「该item 根本没有 tags 字段」 */
const jsonFeed = ({ tags = ['tech', 'news'], title = '标题', content = '正文',
  id = 'example.com,1', author = '作者' } = {}) => JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'Channel',
  items: [{
    id,
    title,
    url: `https://example.com/${id}`,
    authors: author === null ? undefined : [{ name: author }],
    // ⚠️ tags 为 undefined 时整个键不出现，模拟真实缺字段的 feed
    ...(tags === null ? {} : { tags }),
    date_published: '2026-10-01T00:00:00Z',
    content_text: content,
  }],
});

const rss = (cat) => `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Channel</title><item>
  <guid>r1</guid><title>标题</title><link>https://example.com/r1</link>
  <pubDate>Mon, 01 Oct 2026 00:00:00 GMT</pubDate>
  <dc:creator>作者</dc:creator>
  ${cat === null ? '' : `<category>${cat}</category>`}
  <description>正文</description>
</item></channel></rss>`;

const atom = (term) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Channel</title>
  <entry>
    <id>tag:rel,1</id><title>标题</title>
    <link href="https://example.com/a1"/>
    <published>2026-10-01T00:00:00Z</published>
    <updated>2026-10-01T00:00:00Z</updated>
    <content type="html">正文</content>
    ${term === null ? '' : `<category term="${term}"/>`}
  </entry>
</feed>`;

const snap = (parsed, at, url = 'https://example.com/feed.json') =>
  new Snapshot(url, parsed, at);
const fieldsOf = (d) => (d.changes ?? []).flatMap((c) => (c.diff ?? []).map((x) => x.field));

/* ─────────────────────────────────────────────────────────────── */
console.log('【1】JSON Feed 改 tags → 必须检出 category 变化（本缺陷的核心）');

await t('tags tech,news → tech,ai：必须 changed=true 且报出 category', async () => {
  const a = parseJsonFeed(jsonFeed({ tags: ['tech', 'news'] }));
  const b = parseJsonFeed(jsonFeed({ tags: ['tech', 'ai'] }));

  // 前提：除 tags 外一切不变（否则测的不是这个缺陷）
  assert(a.items[0].contentText === b.items[0].contentText, '前提失败：正文变了');
  assert(a.items[0].title === b.items[0].title, '前提失败：标题变了');

  const d = diffSnapshots(snap(a, 't1'), snap(b, 't2'));
  const f = fieldsOf(d);

  assert('category' in a.items[0],
    'JSON Feed item 上应存在 category 键。'
    + `实际键=[${Object.keys(a.items[0]).join(',')}] —— `
    + '修复前该键完全缺失，category 恒undefined。');
  assert(d.changed === true,
    `tags 真实变化却报 changed=false（reason=${d.reason}）—— `
    + '这正是本缺陷：reason=hash_match 表示第一层粗筛就短路，diffItem 根本没进，'
    + '因此**连一条提示都不会产生**，属完全静默失效。');
  assert(d.reason === 'structural_diff',
    `应进入第二层逐字段比对，实际 reason=${d.reason}（hash_match 即粗筛短路）`);
  assert(f.includes('category'),
    `必须报出 category 字段变化，实际 fields=${JSON.stringify(f)}`);
  assert(f.length === 1,
    `只应报 category 一项（其他字段都没变），实际 fields=${JSON.stringify(f)}`);
  return `检出 category 变化（${a.items[0].category} → ${b.items[0].category}）`;
});

await t('粗筛哈希必须随 tags 变化（守卫 hash_match 短路这一层）', async () => {
  // 直接盯住第一层：contentHash 是否覆盖了 tags 的信息
  const a = snap(parseJsonFeed(jsonFeed({ tags: ['tech', 'news'] })), 't1');
  const b = snap(parseJsonFeed(jsonFeed({ tags: ['tech', 'ai'] })), 't2');
  assert(a.contentHash !== b.contentHash,
    '两轮快照的粗筛哈希相同 —— 说明 tags 未进入 TRACKED_FIELDS 的哈希覆盖范围，'
    + 'diffSnapshots 第一层必然返回 hash_match，变更永远检不出。');
  return 'tags 变化使粗筛哈希改变，不再短路';
});

await t('tags 增删（"a" → "a,b"）与顺序变化（"a,b" → "b,a"）均按实际值判定', async () => {
  // 增删：真实变化
  const dAdd = diffSnapshots(
    snap(parseJsonFeed(jsonFeed({ tags: ['a'] })), 't1'),
    snap(parseJsonFeed(jsonFeed({ tags: ['a', 'b'] })), 't2'),
  );
  assert(dAdd.changed === true && fieldsOf(dAdd).includes('category'),
    `tags 新增标签应检出，实际 changed=${dAdd.changed} fields=${JSON.stringify(fieldsOf(dAdd))}`);

  // 顺序变化：本实现按字符串原样比较，故顺序变了会报出变化。
  // 这里锁定「当前行为」而非评判对错 —— 断言的是**它确实被当作变化处理**，
  // 即映射生效后 category 真的参与了判定。
  const dReorder = diffSnapshots(
    snap(parseJsonFeed(jsonFeed({ tags: ['a', 'b'] })), 't1'),
    snap(parseJsonFeed(jsonFeed({ tags: ['b', 'a'] })), 't2'),
  );
  assert(dReorder.changed === true,
    '标签顺序变了应被检出为变化（当前按原样字符串比较）。'
    + '若将来改为排序归一化，本条会红 —— 那是「有意变更」的信号，需同步更新断言。');
  return '增删与顺序变化均检出（顺序语义见注）';
});

await t('tags 本身仍保留在 item 上（删掉会丢规范原生字段）', async () => {
  const a = parseJsonFeed(jsonFeed({ tags: ['tech', 'news'] }));
  assert('tags' in a.items[0], 'tags 字段被删掉了 —— 它是 JSON Feed 规范的原生字段');
  assert(a.items[0].tags === 'tech,news',
    `tags 值应为原始标签串，实际 ${JSON.stringify(a.items[0].tags)}`);
  // 同源同值：两者由同一变量生成，不可能漂移
  assert(a.items[0].tags === a.items[0].category,
    `tags 与 category 应同源同值，实际 tags=${JSON.stringify(a.items[0].tags)} `
    + `category=${JSON.stringify(a.items[0].category)}`);
  // 且能活过持久化往返
  const rt = Snapshot.fromJSON(JSON.parse(JSON.stringify(snap(a, 't1').toJSON())));
  const item = rt.items.get('example.com,1');
  assert(item.tags === 'tech,news' && item.category === 'tech,news',
    `往返后字段应保留，实际 tags=${JSON.stringify(item.tags)} category=${JSON.stringify(item.category)}`);
  return 'tags 与 category 并存且能活过 toJSON/fromJSON';
});

/* ─────────────────────────────────────────────────────────────── */
console.log('\n【2】RSS / Atom 的 category 行为不受影响（防回归）');

await t('RSS 改 <category> → 仍报出 category（映射不得影响 RSS 原路径）', async () => {
  const a = parseRss(rss('tech'));
  const b = parseRss(rss('ai'));
  assert(a.items[0].category === 'tech' && b.items[0].category === 'ai',
    `前提失败：RSS category 解析不对，实际 ${a.items[0].category} / ${b.items[0].category}`);
  const d = diffSnapshots(snap(a, 't1', 'u.rss'), snap(b, 't2', 'u.rss'));
  assert(d.changed === true && fieldsOf(d).includes('category'),
    `RSS category 变化应检出，实际 changed=${d.changed} fields=${JSON.stringify(fieldsOf(d))}`);
  return 'RSS 原路径未受影响';
});

await t('RSS 多 category 仍按逗号连接（映射不得改变 RSS 的连接语义）', async () => {
  const multi = `<?xml version="1.0"?><rss version="2.0"><channel><title>C</title><item>
<guid>r1</guid><title>T</title><link>https://example.com/r1</link>
<category>tech</category><category>news</category><description>正文</description>
</item></channel></rss>`;
  const p = parseRss(multi);
  assert(p.items[0].category === 'tech,news',
    `RSS 多 category 应连接为 'tech,news'，实际 ${JSON.stringify(p.items[0].category)}`);
  return "RSS 多 category 仍为 'tech,news'";
});

await t('Atom 改 <category term> → 仍报出 category', async () => {
  const a = parseAtom(atom('tech'));
  const b = parseAtom(atom('ai'));
  assert(a.items[0].category === 'tech' && b.items[0].category === 'ai',
    `前提失败：Atom category 解析不对，实际 ${a.items[0].category} / ${b.items[0].category}`);
  const d = diffSnapshots(snap(a, 't1', 'u.atom'), snap(b, 't2', 'u.atom'));
  assert(d.changed === true && fieldsOf(d).includes('category'),
    `Atom category 变化应检出，实际 changed=${d.changed} fields=${JSON.stringify(fieldsOf(d))}`);
  return 'Atom 原路径未受影响';
});

await t('三协议同形变化（category 改名）→ 行为一致，不因协议而异', async () => {
  // 同一语义变化分别喂给三个协议，检出结果必须一致 ——
  // 这条直接对应缺陷本质：「统一字段模型要求三协议行为对齐」
  const j = diffSnapshots(
    snap(parseJsonFeed(jsonFeed({ tags: ['tech'] })), 't1'),
    snap(parseJsonFeed(jsonFeed({ tags: ['ai'] })), 't2'),
  );
  const r = diffSnapshots(
    snap(parseRss(rss('tech')), 't1', 'u.rss'),
    snap(parseRss(rss('ai')), 't2', 'u.rss'),
  );
  const a = diffSnapshots(
    snap(parseAtom(atom('tech')), 't1', 'u.atom'),
    snap(parseAtom(atom('ai')), 't2', 'u.atom'),
  );
  for (const [name, d] of [['JSON Feed', j], ['RSS', r], ['Atom', a]]) {
    assert(d.changed === true && fieldsOf(d).includes('category'),
      `${name} 的分类变化未被检出（changed=${d.changed} reason=${d.reason} `
      + `fields=${JSON.stringify(fieldsOf(d))}）—— 三协议行为必须一致`);
  }
  return 'JSON Feed / RSS / Atom 三协议行为已对齐';
});

/* ─────────────────────────────────────────────────────────────── */
console.log('\n【3】⚠️ 假阳性守卫：无 tags 时不得产生告警');

await t('无 tags 字段 → category 为空串（非 undefined），不产生假告警', async () => {
  const p = parseJsonFeed(jsonFeed({ tags: null }));
  const item = p.items[0];
  assert('tags' in item, '前提失败：item 上应有 tags 键（缺省为空串）');
  assert(item.tags === '', `无 tags 应为空串，实际 ${JSON.stringify(item.tags)}`);
  // ⚠️ 关键：必须是 '' 而不是 undefined
  //   undefined 会让 `String(i.category ?? '')` 与 diffItem 的 `a ?? ''` 各自
  //   归一化 —— 单看一处没问题，但语义上「未采集」与「采集到空」应可区分。
  //   这里锁定为 ''，因为它跨轮次稳定、且与 RSS/Atom 无 category 时的行为一致。
  assert(item.category === '',
    `无 tags 时 category 应为空串，实际 ${JSON.stringify(item.category)}`
    + `${item.category === undefined ? '（是 undefined —— 跨轮次可能跳变成假变更）' : ''}`);
  return "category === ''";
});

await t('★ 两轮都无 tags → 完全静默（不产生任何 diff）', async () => {
  const a = snap(parseJsonFeed(jsonFeed({ tags: null })), 't1');
  const b = snap(parseJsonFeed(jsonFeed({ tags: null, title: '标题', content: '正文' })), 't2');
  const d = diffSnapshots(a, b);
  assert(d.changed === false,
    `两轮无任何变化却报 changed=true（fields=${JSON.stringify(fieldsOf(d))}）—— `
    + '空串参与比对时两个空串相等应短路，这是假阳性守卫的核心');
  assert(d.changes.length === 0, '不应产生任何变更条目');
  return "reason=hash_match，空串不产生假 diff";
});

await t('★ 升级场景：旧快照无 category 键 → 首轮不报假变更（undefined → "" 不炸）', async () => {
  // 构造「修复前的基线」：item 上根本没有 category 键
  const oldParsed = parseJsonFeed(jsonFeed({ tags: ['tech', 'news'] }));
  const oldSnap = new Snapshot('u', oldParsed, 't0');
  const legacyJSON = JSON.parse(JSON.stringify(oldSnap.toJSON()));
  delete legacyJSON.items[0].category;   // 模拟修复前落盘的基线
  const restoredOld = Snapshot.fromJSON(legacyJSON);

  const newParsed = parseJsonFeed(jsonFeed({ tags: ['tech', 'news'] })); // tags 没变
  const newSnap = new Snapshot('u', newParsed, 't1');

  const oldItem = restoredOld.items.get('example.com,1');
  assert(!('category' in oldItem),
    `前提失败：旧基线应无 category 键，实际有（${oldItem.category}）`);

  const d = diffSnapshots(restoredOld, newSnap);
  const f = fieldsOf(d);

  // ⚠️ 这是本条最容易被写错的地方。engine.js 的 diffItem 有
  //   `if (!(f in oldItem)) continue;` —— 缺键即「当初没采集」，
  //   跳过该字段、不声称它变了。靠这条守卫，升级后首轮即静默收敛。
  //   若哪天有人删掉那行守卫，这里就会报出 `undefined → 'tech,news'` 的假变更。
  assert(!f.includes('category'),
    `旧基线缺 category 键时首轮报出了假变更（fields=${JSON.stringify(f)}）—— `
    + `engine.js 的 \`if (!(f in oldItem)) continue;\` 守卫是否还在？`
    + `没有它，存量用户升级后会立刻收到一批假告警。`);
  assert(d.changed === false, `应完全无变化，实际 changed=${d.changed}`);
  return '缺键守卫生效，升级首轮不产生假告警';
});

await t('tags 从有到无：视为真实变化（标签确实被移除）', async () => {
  // 与上一条方向相反：这次 category 键在两侧都存在，值从 'tech' 变成 ''
  const parsedB = parseJsonFeed(jsonFeed({ tags: [] }));
  const a = snap(parseJsonFeed(jsonFeed({ tags: ['tech'] })), 't1');
  const b = snap(parsedB, 't2');
  const d = diffSnapshots(a, b);
  assert(parsedB.items[0].category === '',
    `前提失败：空数组应得空串，实际 ${JSON.stringify(parsedB.items[0].category)}`);
  assert(d.changed === true && fieldsOf(d).includes('category'),
    `标签被移除是真实变化，应检出。实际 changed=${d.changed} fields=${JSON.stringify(fieldsOf(d))}`);
  return "'tech' → '' 检出为真实变化";
});

/* ─────────────────────────────────────────────────────────────── */
console.log('\n【4】与数据边界声明的一致性');

await t('category 与 tags 都会落盘（/v1/data-handling 须同时声明两个键）', async () => {
  const p = parseJsonFeed(jsonFeed({ tags: ['tech', 'news'] }));
  const rt = Snapshot.fromJSON(JSON.parse(JSON.stringify(snap(p, 't1').toJSON())));
  const item = rt.items.get('example.com,1');
  for (const k of ['category', 'tags']) {
    assert(k in item,
      `${k} 未能活过持久化往返 ——它会落盘，故 /v1/data-handling 的 `
      + `on_disk['store.json'].snapshots 必须声明 'items[].${k}'`);
  }
  // 声明侧由 persistence-regression.js 的双向门禁保证（它真跑 parser）
  return 'category 与 tags 均落盘，两个键都需声明';
});

await t('JSON Feed 无 tags 时落盘形状仍含两个键（不因缺省而消失）', async () => {
  const p = parseJsonFeed(jsonFeed({ tags: null }));
  const item = p.items[0];
  for (const k of ['category', 'tags']) {
    assert(k in item, `无 tags 时 ${k} 键消失了 —— 落盘形状会随源数据抖动`);
  }
  return '缺省时键仍在、值为空串';
});

/* ─────────────────────────────────────────────────────────────── */
console.log(out.join('\n'));
console.log(`\n═══ 结果：${pass} 项通过，${fail} 项失败 ═══\n`);
if (fail > 0) {
  console.log('⚠️  若【1】失败：JSON Feed 的 tags 未映射进 category ——');
  console.log('    变更是**完全静默**的（reason=hash_match，粗筛层就短路，');
  console.log('    diffItem 根本不进，不产生任何日志或提示）。');
  console.log('  若【2】失败：映射改动了 RSS/Atom 的原有行为，超出修复范围。\n');
} else {
  console.log('ℹ️  回退证伪：把 parseJsonFeed 里extra.category 那行删掉再跑本套件，');
  console.log('    【1】与【4】必须变红 —— 绿了说明这些用例没在测。');
  console.log('  ⚠️ 注意：只删 extra.category 而保留 tags（保留原生字段是对的），');
  console.log('    缺陷会精确地回来。\n');
}
process.exit(fail === 0 ? 0 : 1);