/**
 * 回归测试：atom:updated 的采集与「不参与判定」（2026-10-19，同日两次修订）
 *
 * ── 缺陷（第一次修复要解决的）──
 *   `src/parser/feeds.js` 里 Atom 的 parsed 结果是
 *     `publishedAt: firstText(en.published) || firstText(en.updated)`
 *   —— `atom:updated` 从来没有自己的字段，只作为 published 的**兜底**被消费。
 *   于是只要 `published` 存在（RFC 4287 §4.2.14 要求 entry 必有 published，
 *   现实中几乎所有 Atom feed 都给），`updated` 就永远取不到。
 *
 * ── 第一次修复（已回退）──
 *   把 `updated` 加进 `TRACKED_FIELDS`。**这个方向是对的**
 *   （它确实是 Atom 里唯一为「修改」设计的标准字段），但引入了一个
 *   **实测出来的 100% 假阳性**，见下。
 *
 * ── 为什么回退（实测，非推测）──
 *   实测：Atom feed 仅 `updated` 变化、内容一字未改
 *     changed: true | reason: structural_diff | diff 字段: ["updated"]
 *     模拟一整天4 次检查（内容全程未改）→ 告警 4 条、纯时间戳 4 条
 *     **假阳性率 100%**
 *
 *   根因：**时间戳变化不携带任何内容信息。** 现实中大量feed 每次构建
 *   都会刷新 entry 的updated（CMS 重生成、聚合器重排、缓存重建），
 *   而内容根本没变。
 *
 *   Feedbin 早在 2014 年就放弃依赖 `<updated>`（"which was not always
 *   available"），改用「正文长度变化 > 50 字符」判定
 *   （feedbin.com/blog/2014/12/16/）。我们不该重走这条已被验证的路。
 *
 * ⚠️ **一个容易重犯的错误**：只防「updated 不存在」（空对空不产生 diff）
 *   是不够的 —— 还要防「updated 存在但每次乱刷新」。后者才是常见的。
 *
 * ── 现在的取舍 ──
 *   parser **仍然采集并落盘** updated（保留官方语义，排障时可查
 *   「发布方是否声明过它改过」），但它：
 *     · 不在 TRACKED_FIELDS → 不进粗筛哈希 → 变化不触发 changed
 *     · 不进 diff 载荷     → 用户不会收到 "字段 updated 从 X 变成 Y"
 *
 *   取舍原则：**宁可漏报，不可误报**。误报会让客户被噪音淹没 →
 *   关掉通知 → 不再信任这个工具（漏报客户自己还能去看）。
 *
 * ── 若将来要重新引入 updated ──
 *   必须先解决「时间戳刷新 ≠ 内容修改」的区分问题，且要有真实 feed
 *   分布数据支撑（产品侧正在做30 天验证实验）。不要凭规范文本判断。
 *
 * ── 本文件防守的四条 ──
 *   1. Atom 仅 updated 变化、内容未改 → **不得**产生任何变更（假阳性防线）
 *   2. Atom 同时改 title + updated → 必须报 **title**（真实变更仍可检出）
 *   3. RSS 2.0 恒无 updated → 任何内容变化都不捎带假告警
 *   4. parser 仍产出独立 updated 字段（不与 publishedAt 混同）——
 *      「不参与判定」≠「不采集」，采集能力要保留
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

await t('★★ Atom 只改 updated（内容一字未改）→ **绝不能**产生变更（100% 假阳性防线）', async () => {
  // ⚠️ 这条断言在 2026-10-19 **反向**过一次。
  //   原来这里断言「只改 updated 必须报 modified」，那是把 RFC 文本当成了
  //   「现实中会这样发生」的证据 —— 实测证明它带来 **100% 假阳性**。
  //
  //   前置：其他字段确实都没变（否则测的就不是「只改 updated」）
  const a = parseAtom(atomFeed({ updated: '2026-10-01T00:00:00Z' }));
  const b = parseAtom(atomFeed({ updated: '2026-10-18T09:30:00Z' }));
  assert(a.items[0].title === b.items[0].title, '前提失败：title 变了');
  assert(a.items[0].contentText === b.items[0].contentText, '前提失败：正文变了');
  assert(a.items[0].publishedAt === b.items[0].publishedAt, '前提失败：publishedAt 变了');
  assert(a.items[0].updated !== b.items[0].updated, '前提失败：updated 其实没变');

  const d = diffSnapshots(snap(a, '2026-10-01T00:00:00Z'), snap(b, '2026-10-18T10:00:00Z'));

  assert(d.changed === false,
    `内容一字未改却报「有变化」（reason=${d.reason}，字段=${JSON.stringify(d.changes?.[0]?.diff?.map((x) => x.field))}）`
    + ' —— 这就是100% 假阳性：现实中大量 feed 每次构建都刷新 updated，内容却没变');

  // 更强的断言：模拟一整天连续检查，告警数必须是 0
  let alerts = 0, tsOnly = 0;
  let prev = snap(parseAtom(atomFeed({ updated: '2026-10-19T00:00:00Z' })), 'd0');
  for (let i = 1; i <= 4; i++) {
    const cur = snap(parseAtom(atomFeed({ updated: `2026-10-19T${String(i * 6).padStart(2, '0')}:00:00Z` })), `d${i}`);
    const r = diffSnapshots(prev, cur);
    if (r.changed) {
      alerts += 1;
      if (r.changes.every((c) => (c.diff ?? []).every((x) => x.field === 'updated'))) tsOnly += 1;
    }
    prev = cur;
  }
  assert(alerts === 0,
    `模拟一整天 4 次检查（内容全程未改）产生了 ${alerts} 条告警，其中纯时间戳 ${tsOnly} 条`
    + ` → 假阳性率 ${Math.round((tsOnly / alerts) * 100)}%，应为 0%`);

  return '仅 updated 变化：0 告警（假阳性率 0%），且 hash_match 短路生效';
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

await t('★ 同时改 title 和 updated → 报 title（且载荷里不得出现 updated）', async () => {
  // 真实变更（title 改了）**必须**仍能检出 —— 移出 updated 不能矫枉过正。
  // 载荷里不该再有 updated：时间戳对客户判断「改了什么」没有信息量。
  const a = parseAtom(atomFeed({ updated: '2026-10-01T00:00:00Z', title: 'Item One' }));
  const b = parseAtom(atomFeed({ updated: '2026-10-18T09:30:00Z', title: 'Item One (PRICE RAISED)' }));

  const d = diffSnapshots(snap(a, 't1'), snap(b, 't2'));
  assert(d.changed === true, 'title 真实变化必须 changed:true —— 若这��报无变化，说明移出 updated 过头了');

  const mod = d.changes.find((c) => c.type === 'modified');
  assert(mod, '应报出 modified');

  const fields = mod.diff.map((x) => x.field);
  assert(fields.includes('title'), `应报 title，实际：${fields.join(', ')}`);
  assert(!fields.includes('updated'),
    `载荷里不应出现 updated —— 纯时间戳对客户无信息量，会稀释真实信号。实际：${fields.join(', ')}`);

  const td = mod.diff.find((x) => x.field === 'title');
  assert(String(td.new).includes('PRICE RAISED'), `title.new 不对：${JSON.stringify(td.new)}`);
  return `报出 ${fields.join(' + ')}（updated 不进载荷）`;
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

  // 次轮验证：真实内容变化（title）必须仍能检出。
  // ⚠️ 原来这里断言的是「次轮 updated 变化必须检出」——
  //   那是 updated 参与判定时代的残留，现在 updated 已不参与判定，
  //   若照旧断言会逼迫实现重新引入假阳性。真实变更用 title 验证。
  const next = diffSnapshots(fresh, snap(parseAtom(atomFeed({ updated: '2026-10-20T10:00:00Z', title: 'Item One (fixed)' })), 't3'));
  assert(next.changed === true, '存量基线刷新后，真实的 title 变化必须能检出（否则兼容处理写太宽）');
  const nmod = next.changes.find((c) => c.type === 'modified');
  const nf = nmod?.diff.map((x) => x.field) ?? [];
  assert(nf.includes('title') && !nf.includes('updated'),
    `次轮应只报 title，实际：${nf.join(', ')}`);
  return '升级首轮无假告警，次轮真实 title 变化仍检出';
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

await t('★ JSON Feed 只改 date_modified → 不产生变更（与 atom:updated 同理）', async () => {
  // JSON Feed 的 date_modified 语义等同 atom:updated，此前同样只作为
  // publishedAt 的兜底被消费。**它面临完全相同的问题**，
  // 所以处置也必须一致 —— 不能只修 Atom 一家，那会造成协议间行为不一致
  // （用户换个格式的 feed 就突然收到大量假告警）。
  const jf = (mod, pub = '2026-10-01T00:00:00Z', title = 'Item One') => JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1', title: 'Channel',
    items: [{ id: 'j1', title, url: 'https://example.com/1',
      date_published: pub, date_modified: mod, content_text: 'Original body' }],
  });
  const a = parseJsonFeed(jf('2026-10-01T00:00:00Z'));
  const b = parseJsonFeed(jf('2026-10-18T09:30:00Z'));

  // 采集能力必须保留（「不参与判定」≠「不采集」）
  assert(a.items[0].updated === '2026-10-01T00:00:00Z',
    `JSON Feed 的 updated 应取 date_modified，实际：${JSON.stringify(a.items[0].updated)}`);
  assert(a.items[0].publishedAt === '2026-10-01T00:00:00Z',
    `publishedAt 不应被 date_modified 顶替：${JSON.stringify(a.items[0].publishedAt)}`);

  const d = diffSnapshots(snap(a, 't1'), snap(b, 't2'));
  assert(d.changed === false,
    `只改 date_modified 却报有变化（reason=${d.reason}）—— 与 Atom 同理，是假阳性`);

  // 但真实内容变化仍必须检出
  const c = parseJsonFeed(jf('2026-10-18T09:30:00Z', '2026-10-01T00:00:00Z', 'Item One (edited)'));
  const d2 = diffSnapshots(snap(a, 't1'), snap(c, 't2'));
  assert(d2.changed === true, 'JSON Feed 的真实 title 变化必须能检出');
  return 'date_modified 采集保留、不参与判定；真实变化仍检出';
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
