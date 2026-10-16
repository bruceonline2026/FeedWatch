/**
 * GET /mcp 的友好提示页
 *
 * 背景（2026-10-16）：直接用浏览器访问 https://api.tiici.com/mcp
 * 会看到 {"error":"无此端点：GET /mcp"} —— 那是给人看的 JSON，
 * 很像故障报告。而这个地址会被三类人直接打开：
 *   · Payoneer / 平台的合规审核员（人工访问看看）
 *   · 潜在客户（从注册表点过来）
 *   · 用户以为服务坏了
 *
 * MCP 的 tools/list 走 JSON-RPC over POST，GET 本就不该被支持——
 * 但「正确」不等于「对访客友好」。这里返回一张说明页，
 * 给出可直接复制的客户端配置。
 *
 * ⚠️ 安全约束：此页**不得**泄露任何 Key、端点内部信息或监控数据。
 *
 * @param {string} ver 服务版本号（由调用方传入，避免此处再定义一份）
 */
export function mcpInfoPage(ver) {
  const cfg = JSON.stringify(
    {
      mcpServers: {
        feedwatch: {
          url: 'https://api.tiici.com/mcp',
          headers: { 'x-api-key': '<your-api-key>' },
        },
      },
    },
    null,
    2,
  );
  // 把 < > & 转义，防止破坏 HTML
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FeedWatch MCP endpoint</title>
<meta name="description" content="FeedWatch MCP server endpoint. Connect it to Claude, Cursor, VS Code or Windsurf.">
<meta name="robots" content="noindex">
<link rel="canonical" href="https://api.tiici.com/mcp">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#fbfaf8;--surface:#fff;--surface-2:#f5f4f0;
  --text:#1a1a18;--text-2:#5c5b56;--text-3:#8a8983;
  --border:#e3e1db;--border-2:#cfccc4;
  --accent:#c2410c;--accent-soft:#fff2e8;--accent-border:#fed7aa;
  --ok:#0f6e56;--ok-soft:#e6f5ef;
  --code-bg:#1c1c1a;--code-text:#e8e6e0;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
}
body{font-family:var(--sans);background:var(--bg);color:var(--text);line-height:1.65;font-size:15px;-webkit-font-smoothing:antialiased}
.wrap{max-width:720px;margin:0 auto;padding:0 24px}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:var(--mono);font-size:.88em}
main{padding:56px 0 72px}
.badge{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;
  padding:5px 11px;border-radius:999px;background:var(--ok-soft);color:var(--ok);
  border:1px solid #b8e0d0;margin-bottom:20px}
.dot{width:6px;height:6px;border-radius:50%;background:var(--ok)}
h1{font-size:29px;line-height:1.25;letter-spacing:-.02em;margin-bottom:12px}
.lede{color:var(--text-2);font-size:17px;margin-bottom:28px}
h2{font-size:17px;margin:32px 0 10px;letter-spacing:-.01em}
p{margin-bottom:13px}
.note{background:var(--surface-2);border-left:3px solid var(--border-2);
  padding:13px 16px;margin:18px 0;color:var(--text-2);font-size:14.5px;border-radius:0 6px 6px 0}
pre{background:var(--code-bg);color:var(--code-text);padding:16px 18px;border-radius:10px;
  overflow-x:auto;font-family:var(--mono);font-size:13.5px;line-height:1.65;margin:0 0 14px}
.inline{background:var(--surface-2);padding:2px 6px;border-radius:4px;font-size:13.5px}
.clients{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 4px}
.chip{background:var(--surface);border:1px solid var(--border-2);border-radius:8px;
  padding:6px 12px;font-size:13.5px;color:var(--text-2)}
footer{border-top:1px solid var(--border);padding:22px 0;color:var(--text-3);font-size:13.5px}
.fd{display:flex;gap:18px;flex-wrap:wrap;align-items:center}
.fd nav{margin-left:auto;display:flex;gap:18px}
</style>
</head>
<body>
<main>
<div class="wrap">
  <span class="badge"><span class="dot"></span>Live &middot; v${esc(ver)} &middot; 3 tools</span>
  <h1>This is an MCP server endpoint</h1>
  <p class="lede">FeedWatch monitors RSS, Atom and JSON feeds and reports edits to
     existing items &mdash; not just new ones &mdash; with field-level diffs.</p>

  <div class="note">
    <p><strong>Your browser sent a <span class="inline">GET</span> request, but MCP
       uses <span class="inline">POST</span> with JSON-RPC.</strong>
       So there is nothing to show here. Point an MCP client at this URL instead.</p>
  </div>

  <h2>Connect it</h2>
  <p>Add this to your MCP client configuration:</p>
<pre><code>${esc(cfg)}</code></pre>
  <p>Works with <strong>Claude, Cursor, VS Code, Windsurf, Zed and Replit</strong>.
     Authentication is required &mdash; get a key from
     <a href="https://api.tiici.com/">api.tiici.com</a>.</p>

  <h2>What you get</h2>
  <div class="clients">
    <span class="chip">create_monitor</span>
    <span class="chip">list_monitors</span>
    <span class="chip">check_feed</span>
  </div>
  <p style="margin-top:14px">Three tools. <span class="inline">check_feed</span> works
     without creating a monitor first &mdash; the quickest way to try it.</p>

  <h2>Then just ask</h2>
<pre><code>"Check https://news.ycombinator.com/rss for me"

"Monitor github.com/nodejs/node/releases.atom every 6 hours"

"List my monitors"</code></pre>

  <h2>Why not just RSS?</h2>
  <p>Most feed tools diff the <em>set</em> of item IDs, so anything that changes inside
     an existing item reads as &ldquo;no change&rdquo;. A corrected typo, a quietly
     raised price or an updated CVE entry produces no new item &mdash; so it goes
     unnoticed. FeedWatch compares six fields per item and tells you exactly which
     field changed.</p>
</div>
</main>
<footer>
  <div class="wrap fd">
    <span>© 2026 FeedWatch</span>
    <nav>
      <a href="https://api.tiici.com/">Home</a>
      <a href="https://api.tiici.com/zh/">中文</a>
      <a href="https://api.tiici.com/health">Status</a>
      <a href="https://github.com/bruceonline2026/FeedWatch" target="_blank" rel="noopener">GitHub</a>
    </nav>
  </div>
</footer>
</body>
</html>`;
}