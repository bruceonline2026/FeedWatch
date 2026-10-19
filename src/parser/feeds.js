/**
 * 三协议解析：RSS 2.0 / Atom 1.0 / JSON Feed
 *
 * 统一输出结构：
 * {
 *   format: 'rss' | 'atom' | 'jsonfeed',
 *   title: string,
 *   items: [{ id, title, link, publishedAt, contentHash, ...原始字段 }]
 * }
 *
 * item.id 的选取优先级（决定 diff 的稳定标识）：
 * 1. 显式 id / guid
 * 2. 稳定链接 link
 * 3. 内容哈希（最后兜底，链接会变时仍能识别同一内容）
 */

import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';

/**
 * processEntities 用对象形式配置，而不是 `true`。
 *
 * 踩坑记录：用 `processEntities: true` 时，fast-xml-parser 会套用
 * `maxTotalExpansions: 1000` 的默认值。那本意是防「十亿笑声」DoS 攻击，
 * 但它把**标准实体**（`&lt;` `&amp;` `&quot;`）也一并计数，
 * 而真实 feed 里这类实体极其常见：
 *   · GitHub Releases Atom（nodejs/node）→ 3300 个，直接解析失败
 *   · ruby-lang.org news.rss → 1056 个，直接解析失败
 * 结果是「GitHub release 监控」这个核心场景在生产环境根本跑不通。
 *
 * 现改为：放宽总量上限，但**保留真正的 DoS 防线**——
 *   · maxExpansionDepth: 嵌套深度仍限制在 4（十亿笑声靠深层嵌套）
 *   · maxEntitySize:     单个自定义实体定义仍限 10KB
 * 攻击者要炸掉内存必须构造极深嵌套，仍会被 depth 卡住。
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  processEntities: {
    enabled: true,
    maxEntitySize: 10_000,
    maxExpansionDepth: 4,
    maxTotalExpansions: 200_000,
    maxExpandedLength: 20_000_000,
  },
});

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** 归一化空白，避免排版差异造成假变更 */
function normalizeText(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * 把可能是对象/数组的 XML 节点取为纯文本。
 *
 * 关键场景：<description>Hello <b>world</b></description> 这类含子标签的内容，
 * fast-xml-parser 会返回对象 { '#text': 'Hello ', b: 'world' } 而非字符串。
 * 若直接 String(obj) 会得到 "[object Object]"，导致正文永远为空、diff 全部误报。
 *
 * ★ 修复记录（第三个同类静默失效）：
 *   初版「已修复版」写成 `if (node['#text'] != null) return nodeText(node['#text'])`，
 *   只覆盖了「无 #text」的子标签场景。但真实 feed 里更常见的是
 *   **#text 与子标签并存**：
 *     <description><a href="http://x">link</a>tail</description>
 *       → { a: {…}, '#text': 'tail' }   → 初版只返回 'tail'，'link' 被丢弃
 *     <content type="xhtml"><div><p>Hello <b>world</b></p></div></content>
 *       → '#text' 为 'Hello '，'world' 被丢弃
 *   后果与 Bug 2 完全同类：**正文丢字 → contentHash 恒定 → 永远检测不到内容变化**。
 *   现在改为「#text 与所有子节点一起拼接」，任何一支都不丢。
 *
 *   已知限制：fast-xml-parser 会把一个元素内被标签割裂的文本合并进单个 #text
 *   （"before<p>mid</p>after" → '#text' = 'beforeafter'），因此拼接顺序无法
 *   100% 还原文档顺序（"mid beforeafter"）。这是上游解析器的行为，
 *   保证「不丢内容」优先于「精确顺序」—— 对 diff 而言不丢内容才是关键。
 */
function nodeText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(' ');
  if (typeof node === 'object') {
    // ── #text 与子标签必须一起取值，否则丢字 ──
    // `<description>Hello <b>world</b> tail</description>` 会被解析成
    // `{ b:'world', '#text':'Hello  tail' }` —— 标签前后的两段文本被
    // **合并成一个 #text**，且 fast-xml-parser 把 #text 排在键序末尾。
    //
    // ⚠️ 已知限制（顺序无法还原，2026-10-12 QA 实测确认）：
    //   拼接结果必然是「所有 #text 在前、子节点在后」或反之，
    //   无法还原成 "Hello world tail" 的原始顺序。
    //   fast-xml-parser 只有 preserveOrder:true 才能保留顺序，
    //   而那会把整棵树的输出结构变成数组，重写解析层风险过高。
    //
    //   影响面（⚠️ 2026-10-19 更正，原结论有误）：
    //   · ~~哈希稳定 —— 同一输入结果一致，不会产生虚假变更告警~~
    //     这条**只对「同一输入」成立**，曾被据此判断「不会误报」，是错的：
    //     同一**语义内容**的不同排布会重建出不同字符串 → 不同 contentHash
    //     → 被判为「内容变了」。实测（2026-10-19，gstack-qa-lead 提出、我复现）：
    //       "Hello <b>world</b> and more text" → "world Helloand more text"
    //       "<b>Hello</b> world and more text" → "Hello world and more text"
    //       两者对读者完全等价，contentHash 却不同 → changed:true = 误报。
    //     受控条件下实测误报率 52.4%（Atom/RSS 各 71.4%），且误报 100% 落在
    //     contentText —— 因为其余字段是原子值，不受拼接顺序影响。
    //   · 但**现场暴露面极小**：真实 feed 的 HTML 几乎都被整体转义成单个字符串，
    //     走不到「#text + 子节点并存」这条分支（2026-10-19 实测 0/68 条目命中）。
    //     所以这是「受控条件下才会触发」的缺陷，不是当前线上 urgent 问题。
    //   · 正文长度与原文略有出入
    //   · 仅「跨标签边界的关键词」可能漏命中
    //   · webhook 只发哈希与长度，不发正文，乱序不会外泄给客户
    //   故暂不重写解析层（preserveOrder:true 风险过高），但**注释不得再宣称
    //   「不会产生虚假变更告警」** —— 下一个人会据此做决策。
    return Object.entries(node)
      .filter(([k]) => !k.startsWith('@_'))
      .map(([, v]) => nodeText(v))
      .filter((s) => s !== '')
      .join(' ')
      .trim();
  }
  return '';
}

/**
 * RSS 正文里高频出现的命名 HTML 实体。
 * fast-xml-parser 只解 XML 的 5 个预定义实体（&lt; &gt; &amp; &quot; &apos;），
 * `&hellip;` `&mdash;` `&ldquo;` 这些会原样留在正文里 —— 它们是**显示层等价**的，
 * 不解码就会让 contentText 与站点实际呈现不一致 → 哈希误判为「内容变了」。
 * 这里只补最常见的一批，不引第三方实体表（零新增依赖）。
 */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±',
  times: '×', divide: '÷', frac12: '½', frac14: '¼',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§',
  para: '¶', middot: '·', bull: '•', dagger: '†', permil: '‰',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔',
  ensp: ' ', emsp: ' ', thinsp: ' ', shy: '­',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü',
  ouml: 'ö', auml: 'ä', szlig: 'ß', ntilde: 'ñ',
};

/**
 * 解码命名实体与数字实体。
 *
 * 只解码「一层」，且 `&amp;` 最后解 —— 顺序很重要：
 * 先把 `&amp;lt;` 里的 `&lt;` 解出来会变成 `&`+`lt;`… 实际是
 * `&amp;lt;` → `&lt;`，这是**正确**的一次解码（二次解码是 XSS 放大，不做）。
 */
function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      // 越界或非 printable 一律丢弃，避免注入控制字符影响哈希
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return ' ';
      try { return String.fromCodePoint(code); } catch { return ' '; }
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

function stripHtml(s) {
  return normalizeText(
    decodeEntities(
      String(s ?? '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    )
  );
}

/** 兼容旧调用点：取节点文本（统一走 nodeText） */
function firstText(node) {
  return nodeText(node);
}

function atomLink(entry) {
  const links = toArray(entry.link);
  const alt = links.find(
    (l) => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate')
  );
  if (alt) return alt['@_href'] ?? '';
  const plain = links.find((l) => typeof l === 'string');
  return plain ?? '';
}

function rssLink(item) {
  const l = item.link;
  if (!l) return '';
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) {
    const alt = l.find((x) => x?.['@_rel'] === 'alternate') ?? l[0];
    return alt?.['@_href'] ?? alt?.['#text'] ?? '';
  }
  return l['@_href'] ?? l['#text'] ?? '';
}

/** JSON Feed 官方实现，无需解析 */
export function parseJsonFeed(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const items = toArray(data.items).map((it) => {
    const content = it.content_html ?? it.content_text ?? it.summary ?? '';
    const title = normalizeText(it.title ?? '');
    const url = it.url ?? it.external_url ?? '';
    return makeItem({
      id: it.id ?? url,
      title,
      link: url,
      publishedAt: it.date_published ?? it.date_modified ?? '',
      // ★ 与 Atom 的 atom:updated 同义：JSON Feed 的 date_modified 是
      //   「内容最后修改时间」。此前它只作为 publishedAt 的兜底被消费，
      //   date_published 存在时同样**整个丢弃** —— 与 atom:updated 同一缺陷家族。
      updated: it.date_modified ?? '',
      content,
      extra: {
        author: it.authors?.map((a) => a.name).filter(Boolean).join(', ') ?? '',
        tags: toArray(it.tags).join(','),
      },
    });
  });
  return {
    format: 'jsonfeed',
    title: normalizeText(data.title ?? ''),
    homePageUrl: data.home_page_url ?? '',
    items,
  };
}

/**
 * RSS 2.0（兼容 RDF / RSS 1.0）
 *
 * ★ 修复记录：RSS 1.0（RDF）此前 100% 解析失败。
 *   根因是**命名空间前缀**：解析器没开 removeNSPrefix，所以根节点 key 是
 *   `'rdf:RDF'` 而不是 `'RDF'` —— 原代码 `data?.RDF?.channel` 永远 undefined，
 *   直接抛「不是有效的 RSS/RDF 结构」。RSS 1.0 在中文站点仍很常见（很多政府/媒体站）。
 *   另一个坑：RSS 1.0 的 `<item>` 是 `<channel>` 的**兄弟节点**（都在 rdf:RDF 下），
 *   不在 channel 内部，所以必须同时回退到根节点的 item。
 */
export function parseRss(raw) {
  const data = parser.parse(raw);
  // 不开 removeNSPrefix ⇒ 根 key 带前缀，故两种写法都要认
  const rdf = data?.['rdf:RDF'] ?? data?.RDF ?? null;
  const rss = data?.rss ?? data?.['rss:rss'] ?? null;
  const channel = rss?.channel ?? rdf?.channel ?? data?.channel;
  if (!channel && !rdf) throw new Error('不是有效的 RSS/RDF 结构');

  const items = toArray(channel?.item ?? rdf?.item ?? data?.item);
  return {
    format: 'rss',
    title: normalizeText(firstText(channel?.title ?? rdf?.title)),
    homePageUrl: firstText(channel?.link ?? rdf?.link),
    items: items.map((it) => makeItem({
      // RSS 1.0 没有 <guid>，条目标识只能取 rdf:about 属性（注意带 @_ 前缀）
      id: firstText(it.guid) || aboutOf(it) || rssLink(it),
      title: normalizeText(firstText(it.title)),
      link: rssLink(it) || aboutOf(it),
      publishedAt: firstText(it.pubDate) || firstText(it['dc:date']),
      // RSS 2.0 **没有** <updated> 元素，恒为空 —— 这是符合标准的行为。
      // 不拿 pubDate 填：pubDate 是发布时间，冒充「修改时间」等于造假数据，
      // 且会让每次 diff 都把它当变化信号。
      updated: '',
      content: firstText(it['content:encoded']) || firstText(it.description),
      extra: {
        author: firstText(it['dc:creator']) || firstText(it.author),
        category: toArray(it.category).map((c) => firstText(c)).join(','),
      },
    })),
  };
}

/** RSS 1.0 的 <item rdf:about="…"> 是属性，需按 @_ 前缀取 */
function aboutOf(item) {
  return item?.['@_rdf:about'] ?? item?.['@_about'] ?? '';
}

/** Atom 1.0 */
export function parseAtom(raw) {
  const data = parser.parse(raw);
  const feed = data?.feed ?? data?.['atom:feed'];
  if (!feed) throw new Error('不是有效的 Atom 结构');
  const entries = toArray(feed.entry);
  return {
    format: 'atom',
    title: normalizeText(firstText(feed.title)),
    homePageUrl: atomLink(feed),
    items: entries.map((en) => makeItem({
      id: firstText(en.id),
      title: normalizeText(firstText(en.title)),
      link: atomLink(en),
      // ⚠️ publishedAt 的 `|| updated` 兜底是**向后兼容**，不能删（见 makeItem 注释）
      publishedAt: firstText(en.published) || firstText(en.updated),
      // ★ 方案乙（2026-10-19）：标记「publishedAt 是派生值」。
      //   仅当 published 缺失、实际由 updated 顶替时才为true。
      //   实测影响面：7 个 Atom 源里 2 个（martinfowler.com 30 条 /
      //   overreacted.io 59 条）属此类 —— 不是边缘情况。
      publishedAtDerived: !firstText(en.published) && !!firstText(en.updated),
      // ★ P0 修复（2026-10-19）：atom:updated 曾被整个丢弃。
      //   它与 atom:published 语义不同 —— published 是「首次发布」，
      //   updated 是 RFC 4287 §4.2.15 定义的「publisher 认为 significant 的修改」，
      //   是 Atom 里**唯一为「条目被修改」设计的标准字段**。
      //   折进 publishedAt 后：published 存在时 updated 永远取不到
      //   → 只改 updated（RFC 4287 的标准做法）永远检不出变化。
      updated: firstText(en.updated),
      content: firstText(en.content) || firstText(en.summary),
      extra: {
        author: toArray(en.author).map((a) => normalizeText(firstText(a.name))).filter(Boolean).join(', '),
        category: toArray(en.category).map((c) => firstText(c['@_term'] ?? c)).join(','),
      },
    })),
  };
}

function makeItem({ id, title, link, publishedAt, publishedAtDerived, updated, content, extra = {} }) {
  const cleanTitle = normalizeText(title);
  const cleanContent = stripHtml(content);
  return {
    id: normalizeText(id) || sha256(cleanTitle + cleanContent).slice(0, 32),
    title: cleanTitle,
    link: normalizeText(link),
    // ⚠️ publishedAt 保留「published 缺失时用 updated 兜底」的旧行为。
    //   RFC 4287 §4.2.14 规定 entry 必须有 published，但现实中大量 feed 只给 updated。
    //   改这个会破坏既有基线与 JSON 快照，故**只增不改**。
    //   `updated` 另设一字段承载「修改时间」，两者不再互相顶替。
    publishedAt: normalizeText(publishedAt),
    /**
     * ★ 派生值标记（方案乙，2026-10-19）：publishedAt 缺失时它由 updated 顶替，
     * 是**派生值**而非独立字段，却参与变更判定与上报 → 客户看到「发布时间变了」
     * 会误以为文章被重新发布。这是**误标**（不是凭空假告警）：
     * publisher 按 RFC 4287 §4.2.15 确实声明了「显著修改」，只是字段名错。
     *
     * ⚠️ 只给 true，不给 false —— 未声明就是 false，item 形状更小。
     *⚠️ diffItem 必须读**新 item** 的这个标记，见 engine.js 处的注释。
     */
    ...(publishedAtDerived ? { publishedAtDerived: true } : {}),
    /**
     * ★ 最后一次「显著修改」时间 —— 变化信号。
     * RSS 2.0 无此元素，恒为 ''；**这是符合标准的行为，不造假数据填满它**。
     * 统一字段名 ≠ 每个协议都得有值。
     */
    updated: normalizeText(updated),
    contentHash: sha256(cleanContent),
    contentText: cleanContent,
    ...extra,
  };
}

/**
 * 自动识别协议并解析
 *
 * ★ 修复记录：原实现是 `if (startsWith('{') || /json/i.test(contentType))`，
 *   content-type 的优先级高于实际 body 形状。现实中大量站点把 RSS 误配成
 *   `application/json`（WordPress / 自建站极常见），此时：
 *     JSON.parse('<rss ...>') → SyntaxError 直接冒泡，
 *     一个完全正常的 RSS 源被判为「解析失败」，监控永久 error。
 *   现改为**以 body 实际形状为准**，content-type 仅在 body 形状不明确时作为提示。
 */
export function detectAndParse(raw, contentType = '') {
  const text = typeof raw === 'string' ? raw : raw?.toString('utf8') ?? '';
  // 去掉 BOM 与前导空白后再判形，否则 XML 声明前的 BOM 会让所有 startsWith 失配
  const trimmed = text.replace(/^﻿/, '').trimStart();
  const looksXml = trimmed.startsWith('<');
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');

  // body 形状明确时直接采信，忽略 content-type 的错误声明
  if (!looksXml && (looksJson || /json/i.test(contentType))) {
    return parseJsonFeed(trimmed);
  }
  if (looksXml || /xml/i.test(contentType)) {
    if (/<feed[\s>]/i.test(trimmed) || /<atom[\s>]/i.test(trimmed)) {
      return parseAtom(trimmed);
    }
    if (/<rss[\s>]/i.test(trimmed) || /<rdf:RDF/i.test(trimmed) || /<RDF/i.test(trimmed)) {
      return parseRss(trimmed);
    }
  }
  // 兜底：按 JSON → Atom → RSS 顺序试
  if (looksJson || (!looksXml && /json/i.test(contentType))) {
    try {
      return parseJsonFeed(trimmed);
    } catch {
      /* 继续 */
    }
  }
  try {
    return parseAtom(trimmed);
  } catch {
    /* 继续 */
  }
  return parseRss(trimmed);
}

export const __testing = { normalizeText, stripHtml, toArray, makeItem, nodeText };