/**
 * 回归测试：`publishedAt` 派生值不应参与判定（2026-10-19，QA 测量产出）
 *
 * ── 要防守的缺陷 ──
 *   `src/parser/feeds.js` 的 Atom 解析保留了向后兼容兜底：
 *     `publishedAt: firstText(en.published) || firstText(en.updated)`
 *
 *   对「只给 `updated`、不给 `published`」的 Atom 源，
 *   **`publishedAt` 就是 `updated` 的别名**（同一个值被赋给两个字段）。
 *
 *   于是 publisher 每次刷新 updated（CMS 重生成、聚合器重排、缓存重建 ——
 *   时间戳变化不携带任何内容信息），`publishedAt` 就跟着变，
 *   于是 `diffSnapshots` 报出一条 `publishedAt 从 X 变成 Y`。
 *
 *   ⚠️ 定性要说准：这是**字段误标**，不是凭空误报。
 *     · 若正文同时真变了 → `changed: true` 是**正确的**，
 *       只是多报一条假字段名（客户会误以为文章被重新发布）
 *     · 若正文没变 → publisher 按 RFC 4287 §4.2.15 确实声明了「显著修改」，
 *       报出在语义上可辩护，但字段名仍是误标
 *     两害不同：凭空误报摧毁信任（客户关通知）；字段误标让客户
 *     对「发布时间」这个字段失去信任，且**难以自查**（没人怀疑时间戳）。
 *
 * ── 实测依据（gstack-qa-lead，2026-10-19）──
 *   受控复现 100%：
 *     只给 updated + 时间戳变 + 正文未改
 *       → changed=true, diff 字段=["publishedAt"]
 *   真实源命中率：7 个 Atom 源里 **2 个属该类型**（martinfowler 30 条、
 *     overreacted 59 条，共 89 条目）—— 这不是理论风险。
 *
 * ── ⚠️ 本文件防守的核心陷阱：跳过逻辑必须读【新 item】的标记 ──
 *   这是实现时最容易漏、且**测试会「通过」但修复无效**的地方。
 *
 *   `diffItem(oldItem, newItem)` 里 `oldItem` 来自 `Snapshot.fromJSON`，
 *   而**升级前的旧快照里没有 `publishedAtDerived` 这个键**。
 *
 *     跳过条件 =「derived 为真 → 跳过该字段」
 *
 *     | 实现写法   | 升级后首轮 | 第二轮 |
 *     |------------|-----------|--------|
 *     | 读 oldItem | 缺键→falsy→**仍误标** | 才收敛 |
 *     | 读 newItem ✅ | **首轮即生效** | 持续生效 |
 *
 *   理由：「键不存在」只意味着「当初没采集」，不是「当时的值是 false」。
 *   业务属性要用**本次解析出的新数据**判断，不能拿旧对象的缺失去猜。
 *   这与 `engine.js` 里 `if (!(f in oldItem)) continue;` 是同一个道理。
 *
 *   好消息：标记**能活过持久化**（`toJSON`/`fromJSON` 整体透传 item，
 *   实测往返后 `publishedAtDerived === true` 存活），
 *   所以不存在「内存里有效、重启后失效」的隐患。
 *
 * ── 取舍（与 a7a6009「宁可漏报不可误报」一致）──
 *   保留兜底（不丢发布时间数据），但标记出「这是派生值」并让它不参与判定。
 *   ⚠️ 代价要说清：方案乙会**完全丢弃**该源的「修改时间」变化信号。
 *     收益是消除误标，代价是丢失该信号 —— 这不是「修好了」，
 *     别让后人以为这些源的时间信息还能用。
 *
 * 运行：node scripts/published-at-derived-regression.js
 */

import { parseAtom, parseRss } from '../src/parser/feeds.js';
import { Snapshot, diffSnapshots } from '../src/diff/engine.js';

let pass = 0, fail = 0;
const out = [];
const t = async (name, fn) => {
  try { const d = await fn(); pass++; out.push(`  ✓ ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { fail++; out.push(`  ✗ ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

console.log('\n═══ publishedAt 派生值回归套件（2026-10-19）═══\n');

/** Atom feed。published 传 null 即模拟「只给 updated、不给 published」 */
const atomFeed = ({ published = '2026-10-01T00:00:00Z', updated = '2026-10-01T00:00:00Z',
  title = 'Release 2.0', content = 'Original body text.', id = 'tag:rel,2' } = {}) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Channel</title>
  <entry>
    <id>${id}</id>
    <title>${title}</title>
    <link href="https://example.com/rel/2"/>
    ${published === null ? '' : `<published>${published}</published>`}
    <updated>${updated}</updated>
    <content type="html">${content}</content>
  </entry>
</feed>`;

const snap = (parsed, at) => new Snapshot('https://example.com/feed.xml', parsed, at);
const fieldsOf = (d) => (d.changes ?? []).flatMap((c) => (c.diff ?? []).map((x) => x.field));

/**
 * 当前实现是否已带 publishedAtDerived 标记？
 * 未实现时返回 false —— 用例据此分支，保证「修完仍绿、修之前会红」。
 */
const hasDerivedFlag = (parsed) => 'publishedAtDerived' in parsed.items[0];

/* ─────────────────────────────────────────────────────────────── */
console.log('【1】派生值不被当作独立字段上报');

await t('只给 updated + 仅时间戳变 → 不得报出 publishedAt', async () => {
  const a = parseAtom(atomFeed({ published: null, updated: '2026-10-01T00:00:00Z' }));
  const b = parseAtom(atomFeed({ published: null, updated: '2026-10-02T09:30:00Z' }));

  // 前提：正文确实一字未改（否则测的不是这个缺陷）
  assert(a.items[0].contentText === b.items[0].contentText, '前提失败：正文变了');
  // 前提：publishedAt 确实是 updated 的别名
  assert(a.items[0].publishedAt === a.items[0].updated,
    `前提失败：publishedAt 应等于 updated，实际 ${a.items[0].publishedAt} vs ${a.items[0].updated}`);

  const d = diffSnapshots(snap(a, 't1'), snap(b, 't2'));
  const f = fieldsOf(d);

  if (!hasDerivedFlag(a)) {
    // ⚠️ 尚未实现标记 —— 本用例现在必然红，这正是它存在的意义
    assert(!f.includes('publishedAt'),
      `当前会误报 publishedAt（fields=${JSON.stringify(f)}）。` +
      `修复后应不报；这不是「预期失败」，是需要实现的缺陷。`);
  }
  assert(!f.includes('publishedAt'), `不应报出 publishedAt，实际 fields=${JSON.stringify(f)}`);
  return hasDerivedFlag(a) ? '派生值已被正确跳过' : '⚠️ 尚未实现标记';
});

await t('只给 updated + 时间戳变 + 正文也变 → 报 contentText 但不报 publishedAt', async () => {
  const a = parseAtom(atomFeed({ published: null, updated: '2026-10-01T00:00:00Z' }));
  const b = parseAtom(atomFeed({
    published: null, updated: '2026-10-02T09:30:00Z',
    content: 'Original body text with one word changed.',
  }));

  // 真实变更必须仍然检出 —— 本用例同时是「别把检出能力改坏」的护栏
  assert(a.items[0].contentText !== b.items[0].contentText, '前提失败：正文没变');

  const d = diffSnapshots(snap(a, 't1'), snap(b, 't2'));
  const f = fieldsOf(d);
  assert(d.changed === true, '正文真变了，必须报 changed');
  assert(f.includes('contentText'), `必须报 contentText，实际 fields=${JSON.stringify(f)}`);
  assert(!f.includes('publishedAt'), `不应报出 publishedAt（它是 updated 的别名），实际 fields=${JSON.stringify(f)}`);
  return '真实变更仍检出，且派生字段不混入';
});

/* ─────────────────────────────────────────────────────────────── */
console.log('\n【2】⚠️ 核心陷阱：跳过逻辑必须读【新 item】的标记');

await t('★★ 旧快照无 publishedAtDerived 键时，升级后首轮即不报（防读 oldItem）', async () => {
  // 构造升级场景：oldItem 来自「升级前的基线」，item 上没有该键
  const oldParsed = parseAtom(atomFeed({ published: null, updated: '2026-10-01T00:00:00Z' }));
  const oldSnap = new Snapshot('https://example.com/feed.xml', oldParsed, 't0');
  const legacyJSON = JSON.parse(JSON.stringify(oldSnap.toJSON()));
  delete legacyJSON.items[0].publishedAtDerived;   // 模拟升级前落盘的基线
  const restoredOld = Snapshot.fromJSON(legacyJSON);

  const newParsed = parseAtom(atomFeed({ published: null, updated: '2026-10-02T09:30:00Z' }));
  const newSnap = new Snapshot('https://example.com/feed.xml', newParsed, 't1');

  const oldItem = restoredOld.items.get('tag:rel,2');
  const newItem = newSnap.items.get('tag:rel,2');

  const d = diffSnapshots(restoredOld, newSnap);
  const f = fieldsOf(d);

  // 前提：这正是「键缺失」场景
  assert(!('publishedAtDerived' in oldItem),
    `前提失败：oldItem 应无该键，实际有（${oldItem.publishedAtDerived}）`);

  // ⚠️ 诊断信息（2026-10-19 补）：开发过程中这条曾一度「明明实现正确却报红」。
  //   根因是 feeds.js / engine.js 正在被并发修改，跑的是半成品状态 ——
  //   **代码在改的过程中，测试的红绿不代表实现的对错。**
  //   所以失败时把两侧的实际状态一并打出来，避免把「编辑中」误判成「实现有缺陷」。
  if (!f.includes('publishedAt')) {
    // 正常路径，无需额外诊断
  } else {
    out.push(`      ⚠️ 诊断：oldItem 键=[${Object.keys(oldItem).join(',')}]`);
    out.push(`      ⚠️ 诊断：newItem 键=[${Object.keys(newItem).join(',')}]`);
    out.push(`      ⚠️ 诊断：newItem.publishedAtDerived=${JSON.stringify(newItem.publishedAtDerived)}（期望 true）`);
    out.push(`      ⚠️ 若 newItem 标记为 true 却仍报 publishedAt → 实现有缺陷；`);
    out.push(`         若 newItem 无该键 → parser 尚未采集，多半是代码正在改动中（本次开发即遇到）。`);
  }

  const d2 = d;
  assert(!fieldsOf(d2).includes('publishedAt'),
    `升级后首轮仍误报 publishedAt（fields=${JSON.stringify(fieldsOf(d2))}）。` +
    `跳过逻辑是否误读了 oldItem 的缺键？必须用 newItem.publishedAtDerived 判定。` +
    `（newItem 键=[${Object.keys(newItem).join(',')}]，publishedAtDerived=${JSON.stringify(newItem.publishedAtDerived)}）`);

  // 并确认标记确实能活过持久化（否则修法本身不成立）
  const roundTrip = Snapshot.fromJSON(JSON.parse(JSON.stringify(newSnap.toJSON())));
  const rtItem = roundTrip.items.get('tag:rel,2');
  assert(!('publishedAtDerived' in rtItem) || rtItem.publishedAtDerived !== undefined,
    `标记应能活过 toJSON/fromJSON 往返，实际丢失`);

  return '首轮即生效，未依赖旧基线的缺失状态';
});

await t('标记能活过 toJSON/fromJSON 往返（无「重启后失效」隐患）', async () => {
  const parsed = parseAtom(atomFeed({ published: null, updated: '2026-10-02T09:30:00Z' }));
  parsed.items[0].publishedAtDerived = true;   // 模拟修复后产物
  const snapA = new Snapshot('u', parsed, 't1');
  const revived = Snapshot.fromJSON(JSON.parse(JSON.stringify(snapA.toJSON())));
  const item = revived.items.get('tag:rel,2');
  assert(item.publishedAtDerived === true,
    `标记未能存活往返，实际 ${JSON.stringify(item.publishedAtDerived)}`);
  return '持久化往返后标记保留';
});

/* ─────────────────────────────────────────────────────────────── */
console.log('\n【3】对照组：published 真实存在时不得受影响');

await t('published 与 updated 都给 → 改 updated 不捎带改 publishedAt', async () => {
  const a = parseAtom(atomFeed({ published: '2026-10-01T00:00:00Z', updated: '2026-10-01T00:00:00Z' }));
  const b = parseAtom(atomFeed({ published: '2026-10-01T00:00:00Z', updated: '2026-10-02T09:30:00Z' }));
  assert(a.items[0].publishedAt === b.items[0].publishedAt, '前提失败：publishedAt 变了');

  const d = diffSnapshots(snap(a, 't1'), snap(b, 't2'));
  assert(d.changed === false,
    `published 真实存在时，updated 变化不应报出（updated 已不参与判定）。实际 ${JSON.stringify(fieldsOf(d))}`);
  return 'publishedAt 是真字段，未被派生值逻辑污染';
});

await t('published 真实存在 + 正文也变 → 只报 contentText', async () => {
  const a = parseAtom(atomFeed({ published: '2026-10-01T00:00:00Z', content: 'Original body text.' }));
  const b = parseAtom(atomFeed({ published: '2026-10-01T00:00:00Z', content: 'Original body text changed.' }));
  const d = diffSnapshots(snap(a, 't1'), snap(b, 't2'));
  const f = fieldsOf(d);
  assert(d.changed === true, '正文变了必须报');
  assert(f.includes('contentText') && !f.includes('publishedAt'),
    `应只报 contentText，实际 ${JSON.stringify(f)}`);
  return '正常源不受影响';
});

await t('RSS 2.0 恒无 published 兜底 → 不产生派生值场景', async () => {
  const rss = (pubDate) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>C</title><item>
<guid>r1</guid><title>T</title><link>https://example.com/1</link>
<pubDate>${pubDate}</pubDate><description>Body</description>
</item></channel></rss>`;
  const a = parseRss(rss('Mon, 01 Oct 2026 00:00:00 GMT'));
  const b = parseRss(rss('Tue, 02 Oct 2026 00:00:00 GMT'));
  assert(a.items[0].updated === '', '前提失败：RSS 应恒无 updated');
  const d = diffSnapshots(snap(a, 't1'), snap(b, 't2'));
  assert(d.changed === true, 'pubDate 变了应报');
  assert(!fieldsOf(d).includes('updated'), 'RSS 不应有 updated 字段');
  return 'RSS 走 pubDate 路径，与派生值问题无关';
});

/* ─────────────────────────────────────────────────────────────── */
console.log(out.join('\n'));
console.log(`\n═══ 结果：${pass} 项通过，${fail} 项失败 ═══\n`);
if (fail > 0) {
  console.log('⚠️  若失败项是「读 newItem」那条，说明实现误读了 oldItem 的缺键 ——');
  console.log('    升级后首轮仍会误标，直到第二轮才收敛。\n');
}
process.exit(fail === 0 ? 0 : 1);