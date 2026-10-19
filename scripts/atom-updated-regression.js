/**
 * 回归测试：atom:updated 被丢弃（P0，2026-10-19）
 *
 * ── 缺陷 ──
 *   `src/parser/feeds.js` 里 Atom 的 parsed结果是
 *     `publishedAt: firstText(en.published) || firstText(en.updated)`
 *   —— `atom:updated` 从来没有自己的字段，它只作为 published 的**兜底**被消费。
 *   于是只要 `published` 存在（RFC 4287 §4.2.14 要求 entry 必有 published，
 *   现实中几乎所有 Atom feed 都给），`updated` 就永远取不到。
 *
 * ── 为什么这是 P0 ──
 *   RFC 4287 §4.2.15：`atom:updated` = publisher 认为 **significant** 的修改时间，
 *   它是 Atom 里**唯一为「条目被修改」而设计的标准字段**。
 *   而「告诉客户哪个字段变了」正是本产品的核心卖点（竞品只说「这页变了」）。
 *   站点更正错字 / 改价 / 更新 CVE 条目 —— 按 Atom 标准做法只改 updated，
 *   我们却报「无变化」。**这比竞品还差。**
 *
 *   与 2026-10-17 的 P0-3 同一家族：那次是 `Snapshot.contentHash` 只哈希正文，
 *   导致 6 个 tracked 字段里 5 个检测不到；这次是「以为覆盖了时间字段，
 *   实际漏掉了唯一为修改设计的那一个」。
 *
 * ── 为什么 publishedAt 不能复用 updated ──
 *   两者语义不同：
 *     publishedAt = 首次发布时间，**不应因编辑而改变**（这是它的定义）
 *     updated     = 最后一次「显著修改」时间，**这才是变化信号**
 *   若让 updated 顶替 publishedAt，每次编辑都会伪造一次「重新发布」，
 *   下游按 publishedAt 排序会得到错误的条目顺序。
 *   所以本次修复是**新增独立字段**，不是改写既有字段的语义。
 *
 * ── 三条不该发生的事（本文件重点防守）──
 *   1. RSS 2.0 无 <updated> 元素 → 该字段恒为空，**不得因此产生假告警**，
 *      更不得拿 pubDate 冒充修改时间来「凑齐」字段。
 *   2. publishedAt 的旧行为（`published || updated` 兜底）必须保持，
 *      否则只给 updated 的真实 feed 会丢掉publishedAt。
 *   3. 存量快照（升级前落盘）的 item 上没有 updated 键 ——
 *      「键不存在」≠「值是空串」，当成空串会让每条存量条目升级即报假变更。
 *
 * 运行：node scripts/atom-updated-regression.js
 */

import { parseAtom, parseRss, parseJsonFeed, detectAndParse } from '../src/parser/feeds.js';
import { Snapshot, diffSnapshots } from '../src/diff/engine.js';

let pass = 0, fail = 0;
const out = [];
const t = async (name, fn) => {
  try { const d = await fn(); pass++; out.push(`  ✓ ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { fail++; out.push(`  ✗ ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

console.log('\n═══ atom:updated 回归套件（2026-10-19）═══\n');

/** 构造一条 Atom feed。updated 可变，用来模拟 publisher 声明的「显著修改」 */
const atomFeed = ({ updated, published = '2026-10-01T00:00:00Z', title = 'Item One',
  content = 'Original body', id = 'tag:1' } = {}) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Channel</title>
  <entry>
    <id>${id}</id>
    <title>${title}</title>
    <link href="https://example.com/1"/>
    <published>${published}</published>
    <updated>${updated}</updated>
    <content type="html">${content}</content>
  </entry>
</feed>`;

const rssFeed = ({ pubDate = 'Mon, 01 Oct 2026 00:00:00 GMT', title = 'Item One',
  description = 'Original body', link = 'https://example.com/1' } = {}) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Channel</title>
<item>
  <guid>rss-1</guid><title>${title}</title><link>${link}</link>
  <pubDate>${pubDate}</pubDate><description>${description}</description>
</item></channel></rss>`;

const snap = (parsed, at) => new Snapshot('https://example.com/feed.xml', parsed, at);

/* ─────────────────────────────────────────────────────────────── */
console.log('【1】缺陷本体：只改 atom:updated 必须检出');

await t('★ Atom 只改 updated（title/content/published 全不变）→ 必须报 modified', async () => {
  // 这是 RFC 4287 §4.2.15 的标准做法：内容没变，但 publisher 声明这次修改 significant
  const a = parseAtom(atomFeed({ updated: '2026-10-01T00:00:00Z' }));
  const b = parseAtom(atomFeed({ updated: '2026-10-18T09:30:00Z' }));

  // 前置：其他字段确实都没变（否则测的就不是「只改 updated」）
  assert(a.items[0].title === b.items[0].title, '前提失败：title 变了');
  assert(a.items[0].contentText === b.items[0].contentText, '前提失败：正文变了');
  assert(a.items[0].publishedAt === b.items[0].publishedAt, '前提失败：publishedAt 变了');

  const d = diffSnapshots(snap(a, '2026-10-01T00:00:00Z'), snap(b, '2026-10-18T10:00:00Z'));

  assert(d.changed === true,
    `只改 atom:updated 却报「无变化」（reason=${d.reason}）—— 这就是缺陷本身`);

  const mod = d.changes.find((c) => c.type === 'modified');
  assert(mod, `应报出 modified，实际类型：${[...new Set(d.changes.map((c) => c.type))].join(',') || '无'}`);

  const ud = mod.diff.find((x) => x.field === 'updated');
  assert(ud, `diff 里必须有 updated 字段，实际字段：${mod.diff.map((x) => x.field).join(', ') || '空'}`);
  assert(ud.old === '2026-10-01T00:00:00Z', `old 应为旧 updated，实际：${JSON.stringify(ud.old)}`);
  assert(ud.new === '2026-10-18T09:30:00Z', `new 应为新 updated，实际：${JSON.stringify(ud.new)}`);
  // 只应报 updated 一个字段 —— 若报出别的，说明比较逻辑被污染了
  assert(mod.diff.length === 1,
    `只改updated 时只应报1 个字段，实际报了 ${mod.diff.length} 个：${mod.diff.map((x) => x.field).join(', ')}`);
  return `updated「${ud.old}」→「${ud.new}」`;
});

await t('★ parser 确实产出了独立的 updated 字段（不是复用 publishedAt）', async () => {
  const p = parseAtom(atomFeed({ updated: '2026-10-18T09:30:00Z' }));
  const it = p.items[0];
  assert('updated' in it, `item 上没有 updated 键，实际字段：${Object.keys(it).join(', ')}`);
  assert(it.updated === '2026-10-18T09:30:00Z', `updated 值不对：${JSON.stringify(it.updated)}`);
  // 关键：publishedAt 仍是 published 的值，没被 updated 顶替
  assert(it.publishedAt === '2026-10-01T00:00:00Z',
    `publishedAt 被 updated 污染了：${JSON.stringify(it.publishedAt)} ——`
    + ' 首次发布时间不应因编辑而改变');
  return 'updated 与 publishedAt 各自独立';
});

await t('★ 同时改 title 和 updated → 两个字段都要报', async () => {
  const a = parseAtom(atomFeed({ updated: '2026-10-01T00:00:00Z', title: 'Item One' }));
  const b = parseAtom(atomFeed({ updated: '2026-10-18T09:30:00Z', title: 'Item One (PRICE RAISED)' }));

  const d = diffSnapshots(snap(a, 't1'), snap(b, 't2'));
  assert(d.changed === true, '同时改两个字段必须 changed:true');

  const mod = d.changes.find((c) => c.type === 'modified');
  assert(mod, '应报出 modified');

  const fields = mod.diff.map((x) => x.field);
  assert(fields.includes('title'), `应报 title，实际：${fields.join(', ')}`);
  assert(fields.includes('updated'), `应报 updated，实际：${fields.join(', ')}`);
  assert(mod.diff.length === 2, `应恰好报 2 个字段，实际 ${mod.diff.length} 个：${fields.join(', ')}`);

  const td = mod.diff.find((x) => x.field === 'title');
  assert(String(td.new).includes('PRICE RAISED'), `title.new 不对：${JSON.stringify(td.new)}`);
  return `同时报出 ${fields.join(' + ')}`;
});

/* ─────────────────────────────────────────────────────────────── */
console.log('\n【2】不该发生的事：假告警与回归');

await t('★★ RSS 2.0（无 updated 元素）不得因此产生假告警', async () => {
  // RSS 2.0 规范里根本没有 <updated>，字段恒为空是**符合标准**的行为。
  // 若实现里拿 pubDate 冒充修改时间，每次检查都会把它当变化信号 → 告警 storms。
  const a = parseRss(rssFeed());
  assert(a.items[0].updated === '',
    `RSS 的 updated 应恒为空，实际：${JSON.stringify(a.items[0].updated)} ——`
    + ' 拿 pubDate 冒充修改时间是造假数据');

  // 完全相同的 feed 连查两次 → 必须无变化
  const same = diffSnapshots(snap(a, 't1'), snap(parseRss(rssFeed()), 't2'));
  assert(same.changed === false,
    `相同RSS 两次检查应无变化，实际 changed=true：${JSON.stringify(same.changes)}`);

  // 只改 RSS 真实拥有的字段（title）→ 只应报 title，不应捎带 updated
  const b = parseRss(rssFeed({ title: 'Item One (fixed)' }));
  const d = diffSnapshots(snap(a, 't1'), snap(b, 't2'));
  const mod = d.changes.find((c) => c.type === 'modified');
  assert(mod, '改title 应报 modified');
  const fields = mod.diff.map((x) => x.field);
  assert(fields.includes('title'), `应报 title，实际：${fields.join(', ')}`);
  assert(!fields.includes('updated'),
    `RSS 改title 时不该报 updated（它恒为空），实际：${fields.join(', ')} —— 假告警`);

  // 改 pubDate 也不该产生 updated 变更
  const c = parseRss(rssFeed({ pubDate: 'Tue, 20 Oct 2026 10:00:00 GMT' }));
  const d2 = diffSnapshots(snap(a, 't1'), snap(c, 't2'));
  const mod2 = d2.changes.find((x) => x.type === 'modified');
  const f2 = mod2 ? mod2.diff.map((x) => x.field) : [];
  assert(f2.includes('publishedAt'), `改 pubDate 应报 publishedAt，实际：${f2.join(', ')}`);
  assert(!f2.includes('updated'), `改 pubDate 不该报 updated，实际：${f2.join(', ')} —— 假告警`);

  return 'RSS 无 updated，title/pubDate 变更均不捎带假告警';
});

await t('★★ publishedAt 向后兼容：无 published 时仍用 updated 兜底', async () => {
  // 现实中大量 Atom feed 只给 updated 不给 published（虽违反 §4.2.14 但很常见）。
  // 旧行为是 `published || updated`，改了就会让这些 feed 丢掉 publishedAt。
  const p = parseAtom(`<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>C</title><entry>
  <id>tag:np</id><title>No Published</title>
  <updated>2026-10-05T08:00:00Z</updated><content>body</content>
</entry></feed>`);
  assert(p.items[0].publishedAt === '2026-10-05T08:00:00Z',
    `无 published 时publishedAt 应回落到 updated，实际：${JSON.stringify(p.items[0].publishedAt)}`);
  assert(p.items[0].updated === '2026-10-05T08:00:00Z',
    `updated 应取atom:updated，实际：${JSON.stringify(p.items[0].updated)}`);
  return 'publishedAt 兜底行为保持不变';
});

await t('★★ 存量快照（无 updated 键）升级后不得报假变更', async () => {
  // 这是本次修复**自己引入**的风险，必须锁死：
  // 升级前落盘的快照里，item 上根本没有 updated 这个键。
  // 「键不存在」意思是「当初没采集」，不是「值是空串」。
  // 若当成空串，升级后第一次检查会给每条存量条目报
  // `updated: '' → '2026-10-18T…'` —— 内容一个字都没改。
  const legacy = {
    url: 'https://example.com/feed.xml', format: 'atom', feedTitle: 'Channel',
    fetchedAt: '2026-10-01T00:00:00Z', contentHash: 'legacy-hash',
    items: [{
      id: 'tag:1', title: 'Item One', link: 'https://example.com/1',
      publishedAt: '2026-10-01T00:00:00Z', contentHash: 'x'.repeat(64),
      contentText: 'Original body', author: '', category: '',
      //刻意没有 updated 键 —— 这就是旧版本落盘的样子
    }],
  };
  const restored = Snapshot.fromJSON(legacy);
  assert(!('updated' in restored.items.get('tag:1')),
    '前提失败：构造的存量快照不该有 updated 键');

  // feed内容与落盘时完全一致 —— 零变化
  const fresh = snap(parseAtom(atomFeed({ updated: '2026-10-18T09:30:00Z' })), '2026-10-19T04:00:00Z');
  const d = diffSnapshots(restored, fresh);

  assert(d.changed === false,
    `存量条目零变化却报了 ${d.changes.length} 条变更：`
    + `${JSON.stringify(d.changes.map((c) => c.diff))} —— 升级即假告警，会把所有客户的历史监控点打爆`);

  // 自我修复验证：下一轮基线已含 updated 键，真正的变化必须能检出
  const next = diffSnapshots(fresh, snap(parseAtom(atomFeed({ updated: '2026-10-20T10:00:00Z' })), 't3'));
  assert(next.changed === true, '基线刷新后，真实的 updated 变化必须能检出（否则修复失效）');
  const nmod = next.changes.find((c) => c.type === 'modified');
  const nu = nmod?.diff.find((x) => x.field === 'updated');
  assert(nu?.new === '2026-10-20T10:00:00Z', `刷新后 updated 检出不对：${JSON.stringify(nu)}`);
  return '升级首轮无假告警，且次轮恢复正常检出';
});

await t('★★ 存量快照的 title 变化仍必须检出（防兼容处理写太宽）', async () => {
  // 上一条的兼容处理不能顺手把存量快照的其他字段比较也一起放过 ——
  // 那会把「升级后所有字段都不再报警」变成新的静默失效。
  const legacy = {
    url: 'u', format: 'atom', feedTitle: 'C', fetchedAt: 't0', contentHash: 'legacy',
    items: [{
      id: 'tag:1', title: 'Item One', link: 'https://example.com/1',
      publishedAt: '2026-10-01T00:00:00Z', contentHash: 'x'.repeat(64),
      contentText: 'Original body', author: '', category: '',
    }],
  };
  const d = diffSnapshots(Snapshot.fromJSON(legacy),
    snap(parseAtom(atomFeed({ updated: '2026-10-18T09:30:00Z', title: 'Item One (CHANGED)' })), 't1'));
  assert(d.changed === true, '存量基线下改 title 仍必须检出');
  const mod = d.changes.find((c) => c.type === 'modified');
  const fields = mod.diff.map((x) => x.field);
  assert(fields.includes('title'), `应报 title，实际：${fields.join(', ')}`);
  assert(!fields.includes('updated'),
    `存量基线没有 updated 键，不该报 updated，实际：${fields.join(', ')}`);
  return `存量基线只报 ${fields.join(', ')}`;
});

/* ─────────────────────────────────────────────────────────────── */
console.log('\n【3】同缺陷家族：JSON Feed 的 date_modified');

await t('★ JSON Feed 只改 date_modified 也必须检出（与 atom:updated 同义）', async () => {
  // JSON Feed 的 date_modified 语义等同 atom:updated，此前同样只作为
  // publishedAt 的兜底被消费，date_published 存在时整个丢弃。
  const jf = (mod, pub = '2026-10-01T00:00:00Z') => JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1', title: 'Channel',
    items: [{ id: 'j1', title: 'Item One', url: 'https://example.com/1',
      date_published: pub, date_modified: mod, content_text: 'Original body' }],
  });
  const a = parseJsonFeed(jf('2026-10-01T00:00:00Z'));
  const b = parseJsonFeed(jf('2026-10-18T09:30:00Z'));

  assert(a.items[0].updated === '2026-10-01T00:00:00Z',
    `JSON Feed 的 updated 应取 date_modified，实际：${JSON.stringify(a.items[0].updated)}`);
  assert(a.items[0].publishedAt === '2026-10-01T00:00:00Z',
    `publishedAt 不应被 date_modified 顶替：${JSON.stringify(a.items[0].publishedAt)}`);

  const d = diffSnapshots(snap(a, 't1'), snap(b, 't2'));
  assert(d.changed === true, `只改 date_modified 却报无变化（reason=${d.reason}）`);
  const ud = d.changes.find((c) => c.type === 'modified')?.diff.find((x) => x.field === 'updated');
  assert(ud?.new === '2026-10-18T09:30:00Z', `updated 检出不对：${JSON.stringify(ud)}`);
  return `date_modified「${ud.old}」→「${ud.new}」`;
});

await t('★ JSON Feed 无 date_modified 时 updated 为空且不报假告警', async () => {
  const jf = JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1', title: 'Channel',
    items: [{ id: 'j1', title: 'Item One', url: 'https://example.com/1',
      date_published: '2026-10-01T00:00:00Z', content_text: 'Original body' }],
  });
  const p = parseJsonFeed(jf);
  assert(p.items[0].updated === '', `无 date_modified 时应为 ''，实际：${JSON.stringify(p.items[0].updated)}`);
  const d = diffSnapshots(snap(p, 't1'), snap(parseJsonFeed(jf), 't2'));
  assert(d.changed === false, `相同 JSON Feed 两次检查应无变化，实际：${JSON.stringify(d.changes)}`);
  return '无 date_modified 时恒为空，无假告警';
});

/* ─────────────────────────────────────────────────────────────── */
console.log('\n【4】协议自动识别仍正确');

await t('detectAndParse 仍按 body 形状识别 Atom/RSS', async () => {
  const a = detectAndParse(atomFeed({ updated: '2026-10-18T09:30:00Z' }), 'application/xml');
  assert(a.format === 'atom', `应识别为 atom，实际 ${a.format}`);
  assert(a.items[0].updated === '2026-10-18T09:30:00Z', 'atom updated 不对');
  const r = detectAndParse(rssFeed(), 'application/xml');
  assert(r.format === 'rss', `应识别为 rss，实际 ${r.format}`);
  assert(r.items[0].updated === '', 'rss updated 应为空');
  return 'atom / rss 识别与 updated 取值均正确';
});

/* ─────────────────────────────────────────────────────────────── */
console.log(out.join('\n'));
console.log(`\n═══ 结果：${pass} 项通过，${fail} 项失败 ═══\n`);
process.exit(fail === 0 ? 0 : 1);
