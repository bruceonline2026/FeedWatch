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
    //   影响面（已量化）：
    //   · 哈希稳定 —— 同一输入结果一致，不会产生虚假变更告警
    //   · 正文长度与原文略有出入
    //   · 仅「跨标签边界的关键词」可能漏命中
    //   · webhook 只发哈希与长度，不发正文，乱序不会外泄给客户
    //   故 MVP 阶段接受此限制，不阻塞上线。
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
      publishedAt: firstText(en.published) || firstText(en.updated),
      content: firstText(en.content) || firstText(en.summary),
      extra: {
        author: toArray(en.author).map((a) => normalizeText(firstText(a.name))).filter(Boolean).join(', '),
        category: toArray(en.category).map((c) => firstText(c['@_term'] ?? c)).join(','),
      },
    })),
  };
}

function makeItem({ id, title, link, publishedAt, content, extra = {} }) {
  const cleanTitle = normalizeText(title);
  const cleanContent = stripHtml(content);
  return {
    id: normalizeText(id) || sha256(cleanTitle + cleanContent).slice(0, 32),
    title: cleanTitle,
    link: normalizeText(link),
    publishedAt: normalizeText(publishedAt),
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