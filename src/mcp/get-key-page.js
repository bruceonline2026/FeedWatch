/**
 * 自助取 API Key 页面（GET /get-key）
 *
 * ── 为什么做这个 ──
 * 落地页的「Start free」原本指向 `#how`（三步接入说明），
 * 徐总指出：**用户点「免费开始」却只看到说明，拿不到 Key，人就走了。**
 *
 * 转化链断在这里：
 *   点「Start free」→ 看到一段说明 → 不知道要做什么 → 离开
 * 而「拿到 Key」才是真正的第一步动作 —— 落地页其余内容都是围绕它。
 *
 * ── 设计取舍 ──
 * **不做注册/登录**：验证期要的是「点一下就用」，
 * 任何邮箱验证都是摩擦。改成：填一个邮箱 → 立刻拿到 Key。
 *
 * ⚠️ **这是公开端点，因此必须有三层防护**（否则就是无限 Key 机器）：
 *   ① 邮箱格式校验（挡掉明显脚本）
 *   ② 按 IP 限流：每小时 5 把（挡脚本批量）
 *   ③ 全局日上限：每天 60 把（挡分布式/换 IP）
 * 超出时返回 429 并给出明确提示，而不是静默失败。
 *
 * ⚠️ **本页面不得泄露任何内部信息**：不显示配额数字、不显示引导密钥、
 * 不显示其他人的 Key。Key 只在生成后显示一次，与 /v1/apikeys 的约定一致。
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {string|null} email 用户填的邮箱（GET 首屏为空）
 * @param {object|null} issued { key, label } —— 签发成功时带 Key 明文
 * @param {string|null} error 错误提示（已 HTML 转义前的纯文本）
 * @param {number} remaining 当日剩余可签发数量
 */
export function getKeyPage({ email = null, issued = null, error = null, remaining = null } = {}) {
  const cfg = JSON.stringify(
    {
      mcpServers: {
        feedwatch: {
          url: 'https://api.tiici.com/mcp',
          headers: { 'x-api-key': issued?.key ?? 'YOUR_API_KEY' },
        },
      },
    },
    null,
    2,
  );

  // 三种状态：已签发（显示 Key） / 有错（显示提示） / 首屏（显示表单）
  let body;
  if (issued) {
    body = `<div class="card ok">
  <h2>Your API key is ready</h2>
  <p class="warn">Copy it now — for security we cannot show it again.</p>
  <div class="keybox"><code id="k">${esc(issued.key)}</code><button id="cp" type="button">Copy</button></div>
  <p class="meta">Label: <code>${esc(issued.label)}</code></p>
  <h3>Connect it</h3>
  <pre><code>${esc(cfg)}</code></pre>
  <p class="meta">Works with Claude, Cursor, VS Code, Windsurf, Zed and Replit.
     Or call the REST API directly — see
     <a href="https://api.tiici.com/">api.tiici.com</a>.</p>
  <p class="meta"><strong>Keep this key private.</strong> Anyone with it can use your quota.
     If it leaks, email <a href="mailto:bruceonline2018@gmail.com">bruceonline2018@gmail.com</a>
     and we will rotate it.</p>
</div>`;
  } else if (error) {
    body = `<div class="card bad">
  <h2>Could not issue a key</h2>
  <p class="err">${esc(error)}</p>
  <p class="meta">If this keeps happening, email
     <a href="mailto:bruceonline2018@gmail.com">bruceonline2018@gmail.com</a>.</p>
  <p><a class="btn" href="/get-key">Try again</a></p>
</div>`;
  } else {
    body = `<div class="card">
  <h2>Get your free API key</h2>
  <p class="lede">No account, no password, no card. One key, 5 monitors, free.</p>
  <form method="POST" action="/get-key">
    <label for="email">Where should we send your key?</label>
    <input id="email" name="email" type="email" required autocomplete="email"
           placeholder="you@example.com" value="${esc(email ?? '')}">
    <p class="meta">We use it to send your key and nothing else — no newsletter, no tracking.
       See the <a href="/privacy">privacy policy</a>.</p>
    <button class="btn" type="submit">Create my key</button>
  </form>
  ${remaining !== null ? `<p class="meta">${remaining} keys left today.</p>` : ''}
</div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Get your free API key — FeedWatch</title>
<meta name="description" content="Create a free FeedWatch API key in one step. 5 monitors, no card required.">
<link rel="canonical" href="https://api.tiici.com/get-key">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#fbfaf8;--surface:#fff;--surface-2:#f5f4f0;
  --text:#1a1a18;--text-2:#5c5b56;--text-3:#8a8983;
  --border:#e3e1db;--border-2:#cfccc4;
  --accent:#c2410c;--accent-soft:#fff2e8;--accent-border:#fed7aa;
  --ok:#0f6e56;--ok-soft:#e6f5ef;--warn:#854f0b;--warn-soft:#fdf3e3;
  --code-bg:#1c1c1a;--code-text:#e8e6e0;--radius:12px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
}
body{font-family:var(--sans);background:var(--bg);color:var(--text);
  line-height:1.65;font-size:15px;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:var(--mono);font-size:.88em}
main{padding:52px 24px 72px;display:flex;justify-content:center}
.card{width:100%;max-width:560px;background:var(--surface);
  border:1px solid var(--border);border-radius:var(--radius);padding:34px}
.card.ok{border-color:#b8e0d0;box-shadow:0 0 0 1px #b8e0d0}
.card.bad{border-color:var(--accent-border);background:var(--accent-soft)}
h2{font-size:21px;letter-spacing:-.01em;margin-bottom:12px}
h3{font-size:15px;margin:26px 0 10px}
.lede{color:var(--text-2);margin-bottom:24px}
label{display:block;font-size:13px;font-weight:600;margin-bottom:7px}
input{width:100%;padding:12px 14px;border:1px solid var(--border-2);border-radius:9px;
  font:inherit;font-size:15px;background:#fff;color:var(--text);margin-bottom:12px}
input:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
.btn{display:inline-block;background:var(--accent);color:#fff;border:0;
  padding:12px 22px;border-radius:9px;font:inherit;font-weight:600;font-size:15px;
  cursor:pointer;margin-top:8px}
.btn:hover{background:#9a3412;text-decoration:none}
.meta{font-size:13px;color:var(--text-2);margin-top:12px;line-height:1.6}
.warn{background:var(--warn-soft);color:var(--warn);border:1px solid #f0dfb8;
  border-radius:8px;padding:11px 14px;font-size:14px;margin-bottom:16px}
.err{color:var(--warn);font-weight:600;margin-bottom:8px}
.keybox{display:flex;gap:10px;align-items:stretch;margin:6px 0 4px}
.keybox code{flex:1;background:var(--code-bg);color:var(--code-text);
  padding:14px 16px;border-radius:9px;font-size:14px;word-break:break-all;line-height:1.5}
.keybox button{background:var(--surface-2);border:1px solid var(--border-2);
  border-radius:9px;padding:0 18px;font:inherit;font-weight:600;cursor:pointer;
  color:var(--text-2);white-space:nowrap}
.keybox button:hover{background:#ecebe5}
pre{background:var(--code-bg);color:var(--code-text);padding:16px 18px;border-radius:10px;
  overflow-x:auto;font-family:var(--mono);font-size:13px;line-height:1.65;margin:0}
footer{border-top:1px solid var(--border);padding:20px 24px;
  text-align:center;color:var(--text-3);font-size:13px}
footer a{margin:0 8px}
</style>
</head>
<body>
<main>${body}</main>
<footer>
  <a href="/">Home</a><a href="/privacy">Privacy</a><a href="/zh/" lang="zh-CN">中文</a>
</footer>
${issued ? `<script>
document.getElementById('cp').addEventListener('click',function(){
  var t=document.getElementById('k').textContent;
  var done=function(){var b=document.getElementById('cp');b.textContent='Copied';};
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,function(){});}
  else{var r=document.createRange();r.selectNode(document.getElementById('k'));
    var s=getSelection();s.removeAllRanges();s.addRange(r);done();}
});
</script>` : ''}
</body>
</html>`;
}

export { EMAIL_RE };