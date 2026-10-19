/**
 * 回归测试：`contentText` 重建顺序的**当前行为锁定**（2026-10-19，QA 测量产出）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ 已知现状：这不是「有个 bug 待修」的声明，请勿据此判断紧急度
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `contentText` 重建在「标签顺序不同」时**不稳定**：
 *   受控条件下，同一语义内容的不同标签排布会产出不同字符串
 *   → 不同 contentHash → 被判为「内容变了」= 误报
 *   实测（gstack-qa-lead，2026-10-19）：22/42 次比较 = **52.4%**
 *
 * **但现场触发率为 0** —— 真实 feed 的 HTML 几乎总被整体转义成单个字符串
 *   （`&lt;p&gt;…`），fast-xml-parser 解析出的是纯 `#text` 字符串 + 属性，
 *   **不产生子标签** → `nodeText` 的错乱分支根本走不到。
 *   实测：34 个真实源 × 3 轮 = 68 次比较，误报 **0/68 = 0.0%**；
 *        暴露面 **0/487 条目**。
 *
 * **本套测试的用途**：
 *   ① 锁定当前行为，防止将来无意中改变它（改好、改坏都要有意识地决定）
 *   ② 为将来若修 `preserveOrder` 提供**验收基线** —— 修好后本套会红，
 *      那是「行为有意变更了」的信号，需要同步更新断言与本文档
 *
 * **不是**「有个 urgent bug 待修」。⚠️ 修 `nodeText` 需要动解析层
 *   （`preserveOrder: true` 会把整棵树的输出结构变成数组），是**重写级**改动，
 *   风险远大于当前收益（触发率 0）。**请勿仅因本套测试存在就去改解析层。**
 *
 * ───────────────────────────────────────────────────────────────────────
 * 缺陷机制（已定位到具体配置行）──
 *
 *   `src/parser/feeds.js` 的 XMLParser 配置 `trimValues: true`
 *     → fast-xml-parser 对**每个文本节点** trim 首尾空白
 *       · `<b>x</b> y` 的 #text = "y"，与 b="x" 用 join(' ') 拼回 → **恰好正确**（运气）
 *       · `x <b>y</b>` 的 #text = "xz"（两段 trim 后直接相连）→ 空格**被吃掉**
 *
 *   `nodeText` 的 `Object.entries(node)` 遍历顺序恒为 `[子标签…, '#text']`
 *     （`#text` 永远排最后）→ 子标签的文本被搬到 #text **之前** → 词序错乱
 *
 *   ⚠️ 缺陷**有方向性**，不是「只要有标签就错」：
 *     文本节点在子标签**之后** → 安全（join 的空格恰好补回）
 *     文本节点在子标签**之前** → 必然错乱
 *
 * ───────────────────────────────────────────────────────────────────────
 * 本文件为什么断言「当前会误报」而不是「应该不变」──
 *
 *   若断言「同内容不同排布应判未变更」，测试文件一加入就是**红的**
 *   —— 那会让它无法进 CI，也会让人误以为线上正在爆炸。
 *
 *   所以这里断言的是**当前实现的实际行为**（含具体的错乱字符串），
 *   并在注释里写明「理想行为应是什么」。这样：
 *     · CI 保持绿
 *     · 现状被忠实记录，不被遗忘
 *     · 将来真修好了 → 变红 → 那是有意的行为变更，需同步更新
 *
 * 运行：node scripts/content-text-order-regression.js
 */

import { parseAtom, parseRss, parseJsonFeed } from '../src/parser/feeds.js';
import { Snapshot, diffSnapshots } from '../src/diff/engine.js';
import { XMLParser } from 'fast-xml-parser';

let pass = 0, fail = 0;
const out = [];
const t = async (name, fn) => {
  try { const d = await fn(); pass++; out.push(`  ✓ ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { fail++; out.push(`  ✗ ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

console.log('\n═══ contentText 重建顺序 · 当前行为锁定套件（2026-10-19）═══\n');
console.log('  ℹ️ 已知现状：现场触发率 0/68。本套是【行为守卫】，不是 urgent bug 声明。');
console.log('     修 nodeText 属解析层重写，风险 > 当前收益（详见文件头）\n');

/** 构造 Atom feed，body 即 content 的内联 HTML */
const atomFeed = (body, { id = 'tag:rel,1', title = 'Release', link = 'https://example.com/1',
  published = '2026-10-01T00:00:00Z', updated = '2026-10-01T00:00:00Z' } = {}) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Channel</title>
  <entry>
    <id>${id}</id>
    <title>${title}</title>
    <link href="${link}"/>
    <published>${published}</published>
    <updated>${updated}</updated>
    <content type="html">${body}</content>
  </entry>
</feed>`;

const rssFeed = (body) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Channel</title>
<item>
  <guid>rss-1</guid><title>Release</title><link>https://example.com/1</link>
  <pubDate>Mon, 01 Oct 2026 00:00:00 GMT</pubDate>
  <description>${body}</description>
</item></channel></rss>`;

const snap = (parsed, at) => new Snapshot('https://example.com/feed.xml', parsed, at);
const contentOf = (xml, parser = parseAtom) => parser(xml).items[0].contentText;
const fieldsOf = (d) => (d.changes ?? []).flatMap((c) => (c.diff ?? []).map((x) => x.field));

/**
 * 「浏览器渲染真值」—— 独立实现，不复用 parser 代码，作为对照基准。
 * ⚠️ 必须与 parser 的 stripHtml 语义对齐但**独立实现**，否则就是自己验自己。
 */
const rendered = (markup) => String(markup)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/* ═══════════════════════════════════════════════════════════════════════
 * 【0】前置守卫：样本必须真的走进 nodeText 的对象分支
 *
 * ⚠️ 这条来自 gstack-investigator-2 的质疑，采纳（2026-10-19）：
 *   「断言通过」不等于「测到了目标路径」。若样本的 HTML 被整体转义，
 *   fast-xml-parser 会返回**字符串**，`nodeText` 直接返回 → 根本没进对象分支，
 *   用例会「通过」但什么都没测。
 *
 *   与 `persistence-regression.js` 那道门禁踩的是同一个坑：
 *   那里「手写 fixture」恰好盖住了 JSON Feed 的 category 缺陷；
 *   换成真跑 parser 后第一次跑是绿的（样本没覆盖条件字段出现的那条路径）。
 *   **「换成真跑的」本身不等于「有效的」——还要看样本覆盖了哪些路径。**
 *
 * 本组把「样本确实命中错乱路径」变成可执行断言，而不是靠读代码确认。
 * ═══════════════════════════════════════════════════════════════════════ */
/** 三例的核心样本：A/B 渲染真值相同，重建结果不同 */
const SAMPLES = [
  {
    name: 'S1 加粗范围微调（CMS/WYSIWYG 重排）',
    a: 'Fixed a critical bug in the parser and shipped version 2.0 today.',
    b: 'Fixed a <b>critical bug</b> in the parser and shipped version 2.0 today.',
    reconA: 'Fixed a critical bug in the parser and shipped version 2.0 today.',
    reconB: 'critical bug Fixed ain the parser and shipped version 2.0 today.',
    note: '注意 "run" → "ain"：标签边界处的空格被 trimValues 吃掉',
  },
  {
    name: 'S2 斜体位置变化（渲染器换主题）',
    a: 'Upgrade guide: run npm install then restart the service.',
    b: 'Upgrade guide: run <i>npm install</i> then restart the service.',
    reconA: 'Upgrade guide: run npm install then restart the service.',
    reconB: 'npm install Upgrade guide: runthen restart the service.',
    note: '子标签文本被搬到 #text 之前 → 词序错乱',
  },
  {
    name: 'S3 链接插入（正文里加超链接）',
    a: 'See the advisory for details. Affected versions are 1.0 through 1.4.',
    b: 'See the <a href="https://example.test/advisory">advisory</a> for details. Affected versions are 1.0 through 1.4.',
    reconA: 'See the advisory for details. Affected versions are 1.0 through 1.4.',
    reconB: 'advisory See thefor details. Affected versions are 1.0 through 1.4.',
    note: '注意 "the" → "thefor"：空格被吃掉 + 词序错乱同时发生',
  },
];

console.log('\n【0】前置守卫：样本必须真的进入 nodeText 的对象分支');

/** 与 src/parser/feeds.js 同配置的解析器，仅用于检查节点形态 */
const shapeOf = (body) => {
  const p = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true, parseTagValue: false,
    processEntities: { enabled: true, maxEntitySize: 10_000, maxExpansionDepth: 4, maxTotalExpansions: 200_000, maxExpandedLength: 20_000_000 },
  });
  const node = p.parse(`<content type="html">${body}</content>`).content;
  const isObj = typeof node === 'object' && node !== null;
  const childKeys = isObj ? Object.keys(node).filter((k) => k !== '#text' && !k.startsWith('@_')) : [];
  return {
    isObject: isObj,
    childKeys,
    hasText: isObj && '#text' in node,
    /** 真正触发错乱的判据：对象 + 既有子标签又有 #text */
    hitsScramblePath: isObj && childKeys.length > 0 && '#text' in node,
  };
};

await t('三个样本 S1/S2/S3 均进入对象分支且含子标签（错乱路径）', async () => {
  const rows = SAMPLES.map((s) => ({ name: s.name.split('（')[0], ...shapeOf(s.b) }));
  const bad = rows.filter((r) => !r.hitsScramblePath);
  assert(bad.length === 0,
    `以下样本没进入错乱路径（可能被整体转义绕开），断言会在「没测到目标」的情况下空过：\n` +
    bad.map((r) => `  ${r.name}: isObject=${r.isObject} childKeys=[${r.childKeys}] hasText=${r.hasText}`).join('\n'));
  return rows.map((r) => `${r.name}[${r.childKeys.join(',')}]`).join(' · ');
});

await t('对照：转义形态与 CDATA 均不进入错乱路径（这正是现场 0/68 的机制）', async () => {
  // ⚠️ 我第一版在这里断言「CDATA 应解析为字符串」—— **实测是错的**。
  //   CDATA 同样被解析成**对象**，只是形态是 `{ '#text': '<b>critical</b>...' }`：
  //   标签没被解析成子节点，而是作为**文本内容**留在 #text 里。
  //   （fast-xml-parser 对 CDATA 特殊处理：内容按原文保留，不当 markup 解析。）
  //   所以判据不是「是字符串」，而是「**有没有子标签键**」。
  const escaped = shapeOf('Fixed a &lt;b&gt;critical&lt;/b&gt; bug today.');
  const cdata = shapeOf('<![CDATA[Fixed a <b>critical</b> bug today.]]>');

  // 转义形态：对象但只有 #text（标签被解码成文本，未成为子节点）
  assert(escaped.isObject && escaped.childKeys.length === 0 && escaped.hasText,
    `转义形态应是「对象但只有 #text」（无子标签 → 不触发），实际 ${JSON.stringify(escaped)}`);
  assert(!escaped.hitsScramblePath, '转义形态不应命中错乱路径');

  // CDATA：同样是「对象但只有 #text」，**不是**字符串
  assert(cdata.isObject, `CDATA 会解析为对象（{#text,...}），实际 isObject=${cdata.isObject}`);
  assert(cdata.childKeys.length === 0 && cdata.hasText,
    `CDATA 应无子标签键，实际 ${JSON.stringify(cdata)}`);
  assert(!cdata.hitsScramblePath, 'CDATA 不应命中错乱路径');

  return `转义：对象(无子标签) · CDATA：对象(无子标签，标签留在 #text 文本里) —— 均不触发`;
});

/* ═══════════════════════════════════════════════════════════════════════
 * 【1】三个真实场景的误报样本
 *
 * 每个样本：源 A 与源 B 的**浏览器渲染结果逐字相同**，
 * 但重建结果不同 → diffSnapshots 报 changed:true = 误报。
 * ═══════════════════════════════════════════════════════════════════════ */
console.log('\n【1】同内容不同标签排布 → 当前会误报（已知现状，非待修缺陷）');


for (const s of SAMPLES) {
  await t(`${s.name} —— 渲染真值相同但重建不同 → 当前会误报`, async () => {
    // 前提 1：两份源在浏览器里渲染出的可见文本**逐字相同**
    const ra = rendered(s.a);
    const rb = rendered(s.b);
    assert(ra === rb,
      `前提失败：两个样本的渲染真值应相同，实际\n  A=${JSON.stringify(ra)}\n  B=${JSON.stringify(rb)}`);

    // 前提 2：当前实现确实重建出不同内容（这就是本套要锁定的「现状」）
    const ca = contentOf(atomFeed(s.a));
    const cb = contentOf(atomFeed(s.b));
    assert(ca === s.reconA, `重建 A 与记录不符\n  期望 ${JSON.stringify(s.reconA)}\n  实际 ${JSON.stringify(ca)}`);
    assert(cb === s.reconB, `重建 B 与记录不符\n  期望 ${JSON.stringify(s.reconB)}\n  实际 ${JSON.stringify(cb)}`);
    assert(ca !== cb, `前提失败：两者重建应不同（若相同说明行为已变，需更新本套断言）`);

    // 现状：diffSnapshots 因此报出 contentText 变化
    const d = diffSnapshots(
      snap(parseAtom(atomFeed(s.a)), 't1'),
      snap(parseAtom(atomFeed(s.b)), 't2'),
    );
    assert(d.changed === true, `现状应报 changed=true（已知缺陷），实际 ${d.changed}`);
    const f = fieldsOf(d);
    assert(f.includes('contentText'), `应报 contentText，实际 ${JSON.stringify(f)}`);
    assert(!f.includes('title') && !f.includes('link'),
      `不该波及其他字段，实际 ${JSON.stringify(f)}`);

    return `「${ca.slice(0, 28)}…」→「${cb.slice(0, 28)}…」；${s.note}；理想行为应是二者相同`;
  });
}

/* ═══════════════════════════════════════════════════════════════════════
 * 【2】缺陷的方向性（这是最容易被误传的部分）
 * ═══════════════════════════════════════════════════════════════════════ */
console.log('\n【2】缺陷有方向性：文本在子标签【之前】才错乱');

await t('文本在子标签之前 → 空格被吃掉 + 词序错乱', async () => {
  const got = contentOf(atomFeed('Hello <b>world</b> and more text'));
  assert(got === 'world Helloand more text',
    `重建结果与记录不符，实际 ${JSON.stringify(got)}`);
  // 与渲染真值对比：字母都在，但顺序错乱且 "Hello and" 的空格消失
  assert(got !== 'Hello world and more text', '重建结果不应等于渲染真值（这是缺陷本身）');
  return `"Hello <b>world</b> and more text" → ${JSON.stringify(got)}（真值应为 "Hello world and more text"）`;
});

await t('文本在子标签之后 → 当前恰好正确（join 的空格补回来了）', async () => {
  const got = contentOf(atomFeed('<b>Hello</b> world and more text'));
  assert(got === 'Hello world and more text',
    `标签在后应恰好正确，实际 ${JSON.stringify(got)}`);
  assert(got === rendered('<b>Hello</b> world and more text'),
    '此路径当前与渲染真值一致');
  return '「<b>Hello</b> world」→ 正确；这解释了为何「不是所有带标签的正文都会出错」';
});

await t('多个交替标签 → 错乱更严重（词序完全颠倒）', async () => {
  const got = contentOf(atomFeed('a <i>b</i> c <b>d</b> e'));
  assert(got === 'b d ace', `重建结果与记录不符，实际 ${JSON.stringify(got)}`);
  return `"a <i>b</i> c <b>d</b> e" → ${JSON.stringify(got)}（真值 "a b c d e"）`;
});

/* ═══════════════════════════════════════════════════════════════════════
 * 【3】为什么现场触发率是 0（这条决定了紧急度）
 * ═══════════════════════════════════════════════════════════════════════ */
console.log('\n【3】现场不触发的机制：HTML 被整体转义 → 不产生子标签');

await t('转义后的 HTML 整段成字符串 → 不触发错乱分支', async () => {
  // 真实 feed 的典型形态：< 被转义成 &lt;，fast-xml-parser 拿到的是纯文本
  const escaped = 'Fixed a &lt;b&gt;critical&lt;/b&gt; bug in the parser today.';
  const got = contentOf(atomFeed(escaped));
  // 实体解码后应还原为纯文本，标签不参与解析 → 无子标签 → 无错乱
  assert(got === 'Fixed a critical bug in the parser today.',
    `转义形态应正确还原，实际 ${JSON.stringify(got)}`);

  const plain = 'Fixed a critical bug in the parser today.';
  assert(got === contentOf(atomFeed(plain)),
    '转义形态与纯文本形态应产出相同 contentText');
  return '这是现场 0/68 的机制原因：真实 feed 多为此形态，错乱分支走不到';
});

await t('CDATA 包裹 → 同样不触发', async () => {
  const cdata = '<![CDATA[Fixed a <b>critical</b> bug today.]]>';
  const got = contentOf(atomFeed(cdata));
  assert(got === 'Fixed a critical bug today.', `CDATA 应正确处理，实际 ${JSON.stringify(got)}`);
  return 'CDATA 解析成 {#text} 对象但无子标签键，标签作为文本保留 → 不触发错乱';
});

await t('未转义的内联 HTML → 触发错乱（这正是「将来可能出现」的风险面）', async () => {
  const inline = 'Fixed a <b>critical</b> bug in the parser today.';
  const got = contentOf(atomFeed(inline));
  assert(got !== rendered(inline) || got !== 'Fixed a critical bug in the parser today.',
    `未转义形态当前应出现错乱，实际 ${JSON.stringify(got)}`);
  return `一旦某个源改为输出未转义内联 HTML → ${JSON.stringify(got)}`;
});

/* ═══════════════════════════════════════════════════════════════════════
 * 【4】跨协议一致性
 * ═══════════════════════════════════════════════════════════════════════ */
console.log('\n【4】三种协议表现一致（同一套 nodeText）');

await t('Atom 与 RSS 同形（都经 XML 解析）；JSON Feed 不同形', async () => {
  const body = 'Hello <b>world</b> and more text';
  const json = JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1', title: 'C',
    items: [{ id: 'j1', title: 'R', url: 'https://example.com/1',
      date_published: '2026-10-01T00:00:00Z', content_html: body }],
  });
  const atom = contentOf(atomFeed(body));
  const rss = contentOf(rssFeed(body), parseRss);
  const jf = contentOf(json, parseJsonFeed);

  // Atom 与 RSS 都走 fast-xml-parser 的对象分支 → 错乱形态相同
  assert(atom === rss,
    `Atom 与 RSS 应同形（都经 XML 解析）\n  Atom=${JSON.stringify(atom)}\n  RSS=${JSON.stringify(rss)}`);
  assert(atom === 'world Helloand more text',
    `Atom 错乱形态与记录不符，实际 ${JSON.stringify(atom)}`);

  // ⚠️ JSON Feed **不同形** —— 它的 content_html 是 JSON 字符串，
  //   不经 XML 解析 → 不产生子标签 → 不走 nodeText 的错乱分支。
  //   这正是实测中 JSON Feed 误报率（14.3%）远低于 Atom/RSS（71.4%）的原因。
  //   ⚠️ 不要把这里写成「三者一致」—— 我第一版就是这么写的，且它是错的。
  assert(jf === 'Hello world and more text',
    `JSON Feed 应保持正确（不经 XML 解析），实际 ${JSON.stringify(jf)}`);
  assert(atom !== jf, 'Atom 与 JSON Feed 当前应不同形（前者错乱、后者正确）');

  return `Atom/RSS=${JSON.stringify(atom)}（错乱） vs JSONFeed=${JSON.stringify(jf)}（正确）`;
});

await t('JSON Feed 的 content_html 通常不经 XML 解析 → 风险面不同', async () => {
  // 这是实测中 JSON Feed 误报率明显低于 Atom/RSS 的原因（14.3% vs 71.4%）
  const a = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'C',
    items: [{ id: 'j1', title: 'R', url: 'https://example.com/1', content_html: 'Hello world and more text' }] });
  const b = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'C',
    items: [{ id: 'j1', title: 'R', url: 'https://example.com/1', content_html: '<b>Hello</b> world and more text' }] });
  const ca = contentOf(a, parseJsonFeed);
  const cb = contentOf(b, parseJsonFeed);
  assert(ca === cb, `JSON Feed 两种排布应产出相同（无子标签解析），实际 ${JSON.stringify(ca)} vs ${JSON.stringify(cb)}`);
  return 'JSON Feed 里 content_html 是 JSON 字符串，不走 nodeText 的对象分支';
});

/* ═══════════════════════════════════════════════════════════════════════
 * 汇总
 * ═══════════════════════════════════════════════════════════════════════ */
console.log(out.join('\n'));
console.log(`\n═══ 结果：${pass} 项通过，${fail} 项失败 ═══\n`);
console.log('  ℹ️ 本套锁定的是【当前行为】，其中若干项记录的是缺陷本身。');
console.log('     若将来修 nodeText（preserveOrder），本套会红 —— 那是「有意变更」的信号，');
console.log('     需同步更新断言与文件头说明，而不是把红当回归。');
console.log('     修 nodeText 属解析层重写，风险 > 当前收益（现场触发率 0），请勿轻率启动。\n');
process.exit(fail === 0 ? 0 : 1);