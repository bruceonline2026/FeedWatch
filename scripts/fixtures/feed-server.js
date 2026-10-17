/**
 * e2e / P0 回归测试用的本地 HTTP fixture —— 提供**真能抓到**的 RSS/Atom。
 *
 * ── 为什么需要它 ──
 * 2026-10-17 修 P0-1（建点预检）时暴露出一个测试盲区：
 *
 *   整个 e2e 套件**0 处**使用真实可达的 feed，建监控点全靠
 *   `d8-test.com` / `freq-900.com` 这类**假域名**。
 *
 *   在「建点不预检」的世界里这能通过 —— 因为代码**从不真的去抓**。
 *   加了预检后它们全部变成 422（域名解析失败），5 项测试变红。
 *
 *   ⚠️ 这本身是「只声明不强制」的一个变体：测试声称覆盖了「建监控点」，
 *   却从未验证过「这个 URL 真的能被抓到」。产品一改（加了真实校验），
 *   测试的假设就暴露了。
 *
 * ── 为什么用本地 fixture 而不是公网 feed ──
 *   ① 公网 feed 让测试依赖外网（本项目今天已多次因网络抖动失败）
 *   ② 公网 feed 内容会变，无法稳定断言「第 2 次必须 changed:false」
 *   ③ 本地 fixture 能**精确控制内容变化**，从而真正验证
 *      「字段级 diff」—— 这个我们卖的核心能力
 *
 * ── SSRF 注意 ──
 *   fixture 监听 127.0.0.1，而 SSRF 防护会拒绝内网地址。
 *   因此测试子进程必须设 `FEEDWATCH_ALLOW_LOCAL_FETCH=1`，
 *   **且该开关只放行回环地址**（见 src/security/ssrf.js）。生产不设。
 *
 * ── 本文件自身踩过的两个坑（都让测试「绿但没测到东西」）──
 *   ① 最早版在 handler 开头统一写了 RSS 头，分支里又写一次 HTML 头，
 *      触发 ERR_HTTP_HEADERS_SENT 且**实际返回的是 RSS 内容**
 *      → 「非 feed 应被拒」这条测试拿到 201，却是绿的。
 *   ② setTitleOfFirst 用 `/<title>[^<]*<\/title>/` 替换，
 *      改到的是**频道标题**（RSS 里第一个 <title> 属于 channel），
 *      条目标题根本没变 → 「改标题应被检出」拿到 changed:false。
 *
 *   **两次都是「fixture 没改到目标」，却被误读成「被测代码没生效」。**
 */

import { createServer } from 'node:http';

/**
 * @returns {Promise<{url:string, atomUrl:string, htmlUrl:string, emptyUrl:string,
 *   errorUrl:string, setBody:(xml:string)=>void, setTitleOfFirst:(t:string)=>void,
 *   setLinkOfFirst:(l:string)=>void, setDescriptionOfFirst:(d:string)=>void,
 *   hits:()=>number, close:()=>Promise<void>}>}
 */
export async function startFeedFixture({ onRequest } = {}) {
  /** 当前 body —— 测试改这个值来模拟「feed 变了」 */
  let body = sampleFeed();
  let hits = 0;

  const server = createServer((req, res) => {
    hits += 1;
    onRequest?.(req);
    // ⚠️ 必须用 new URL(req.url, base).pathname，**不能**用 req.url.split('?')[0]。
    //   经代理转发时，Node 服务端收到的 req.url 是**绝对 URI**
    //   （`http://127.0.0.1:65012/not-a-feed.html`），split 得到的
    //   是整个绝对 URI，与任何路径常量都不相等 → 分支全部落空，
    //   走到兜底分支返回 RSS —— 于是「非 feed 应被拒」拿到 201。
    //   症状极具迷惑性：**第一次 422、第二次起就 201**，
    //   看起来像「SSRF 校验第二次就放行」，实际是 fixture 自己的路由没匹配上。
    let path;
    try {
      path = new URL(req.url ?? '/', 'http://fixture.invalid').pathname;
    } catch {
      path = (req.url ?? '/').split('?')[0];
    }

    // ⚠️ 必须**先决定 content-type 再 writeHead**，且每分支只写一次 ——
    //   见文件头「坑①」。
    if (path === '/not-a-feed.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end('<!DOCTYPE html><html><head><title>Not a feed</title></head>'
        + '<body><h1>Plain web page, not an RSS feed.</h1></body></html>');
      return;
    }
    if (path === '/empty.xml') {
      res.writeHead(200, {
        'content-type': 'application/xml; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end('<?xml version="1.0"?><root><notfeed/></root>');
      return;
    }
    if (path === '/atom.xml') {
      res.writeHead(200, {
        'content-type': 'application/atom+xml; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(sampleAtom());
      return;
    }
    if (path === '/500.xml') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('upstream boom');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  /**
   * 按 guid 定位**条目内部**的某个字段。
   *
   * ⚠️⚠️ **三个坑都在这里**：
   *   ① 不能用「第一个 <title>」—— 那是频道标题（见文件头坑②）。
   *   ② **不能跨条目**：`<item>[\s\S]*?<guid>` 里 `[\s\S]*?` 会一路
   *      跨过 `</item><item>`，于是「第一个 item 的前缀 + 第二个 item 的
   *      title」被拼在一起 —— 实际改到的是**第二个条目**。
   *      实测症状：diff 报 `old:"Item Two"`（我以为改的是 Item One），
   *      被误读成「diff 引擎匹配错条目」，其实是我 fixture 改错了对象。
   *   ③ 找到的字段若不在这个 item 内，要**报错**而非静默替换 ——
   *      静默失败会让测试误判成「代码没生效」（已发生过三次）。
   *
   * 正确做法：先按 `</item>` 把 body 切成一个个条目，
   * 再在**第一条**内部做替换，绝不跨界。
   */
  const editFirstItem = (tag, value) => {
    const idx = body.indexOf('<item>');
    if (idx < 0) throw new Error('fixture: body 里没有 <item>，无法修改');
    const end = body.indexOf('</item>', idx);
    if (end < 0) throw new Error('fixture: 第一个 <item> 没有闭合');

    // ⭐ 只在第一条 item 的片段内替换 —— 片段不含 </item>，天然不会跨界
    const item = body.slice(idx, end);
    const re = new RegExp(`<${tag}>[^<]*</${tag}>`);
    if (!re.test(item)) {
      throw new Error(`fixture: 第一个条目里找不到 <${tag}>，无法修改`);
    }
    body = body.slice(0, idx)
      + item.replace(re, `<${tag}>${value}</${tag}>`)
      + body.slice(end);
  };

  return {
    url: `http://127.0.0.1:${port}/feed.xml`,
    atomUrl: `http://127.0.0.1:${port}/atom.xml`,
    htmlUrl: `http://127.0.0.1:${port}/not-a-feed.html`,
    emptyUrl: `http://127.0.0.1:${port}/empty.xml`,
    errorUrl: `http://127.0.0.1:${port}/500.xml`,

    setBody: (xml) => { body = xml; },
    setTitleOfFirst: (t) => editFirstItem('title', t),
    setLinkOfFirst: (l) => editFirstItem('link', l),
    setDescriptionOfFirst: (d) => editFirstItem('description', d),

    hits: () => hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 两条目 RSS —— 字段刻意填满，便于验证六个 tracked fields */
export function sampleFeed() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Fixture Feed</title>
    <link>https://example.com</link>
    <description>test fixture</description>
    <item>
      <title>Item One</title>
      <link>https://example.com/1</link>
      <guid>https://example.com/1</guid>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
      <description>Original description one</description>
      <author>alice@example.com</author>
      <category>news</category>
    </item>
    <item>
      <title>Item Two</title>
      <link>https://example.com/2</link>
      <guid>https://example.com/2</guid>
      <pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate>
      <description>Original description two</description>
      <author>bob@example.com</author>
      <category>tech</category>
    </item>
  </channel>
</rss>`;
}

/** 一个 Atom 条目 —— 验证协议自动识别 */
export function sampleAtom() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Fixture Atom</title>
  <link href="https://example.org/"/>
  <updated>2024-01-01T00:00:00Z</updated>
  <id>urn:fixture</id>
  <entry>
    <title>Atom Entry</title>
    <link href="https://example.org/a1"/>
    <id>urn:fixture:a1</id>
    <updated>2024-01-01T00:00:00Z</updated>
    <summary>atom summary</summary>
  </entry>
</feed>`;
}
