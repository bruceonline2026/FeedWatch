/**
 * SSRF 防护 — P0 安全项
 *
 * 监控服务会去请求用户提交的 URL。若无防护，攻击者可用我们的服务器
 * 探测内网资源（127.0.0.1、10.x、192.168.x、云厂商元数据 169.254.169.254），
 * 或让我们的出口 IP 变成攻击跳板。
 *
 * 防护策略：
 * 1. 仅允许 http/https
 * 2. DNS 解析后逐个 IP 校验，拒绝私有/保留网段
 * 3. 重定向每一跳都重新校验（防绕过）
 * 4. ★ 连接时锁定已校验的 IP（防 DNS rebinding）
 *
 * ── 关于第 4 点的实现说明（2026-10-12 修复）────────────────────────
 * 旧实现调用 `buildPinnedDispatcher()`，试图用 undici Agent 锁定 IP，
 * 但 `globalThis.__undici` 从未被赋值，该函数恒返回 undefined：
 *   · `dispatcher.close?.()` 在 dispatcher 为 undefined 时会直接抛
 *     TypeError（可选链只保护 `.close`，保护不了 undefined 本身）
 *     → 100% 的抓取全部失败，服务从未成功抓到过任何 feed。
 *   · 所谓的 DNS rebinding 防护是空的：校验后仍把原始 hostname 交给
 *     fetch()，由 fetch 独立再解析一次 DNS，存在 TOCTOU 窗口。
 *
 * 现改为用 node:http/https 的 `lookup` 选项把连接钉在已校验的 IP 上，
 * 同时 Host 头与 SNI 仍为原始域名（虚拟主机不受影响）。
 * 零新增依赖 —— 服务器出网受限，装不了 undici。
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';

const PRIVATE_V4 = [
  { net: '0.0.0.0', bits: 8 },
  { net: '10.0.0.0', bits: 8 },
  { net: '100.64.0.0', bits: 10 },        // CGNAT
  { net: '127.0.0.0', bits: 8 },
  { net: '169.254.0.0', bits: 16 },       // 含云元数据 169.254.169.254
  { net: '172.16.0.0', bits: 12 },
  { net: '192.0.0.0', bits: 24 },
  { net: '192.168.0.0', bits: 16 },
  { net: '198.18.0.0', bits: 15 },
  { net: '198.51.100.0', bits: 24 },
  { net: '203.0.113.0', bits: 24 },
  { net: '224.0.0.0', bits: 4 },          // 组播
  { net: '240.0.0.0', bits: 4 },          // 保留
];

function v4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8 >>> 0) + Number(o), 0) >>> 0;
}

function isPrivateV4(ip) {
  const val = v4ToInt(ip);
  return PRIVATE_V4.some(({ net, bits }) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (val & mask) === (v4ToInt(net) & mask);
  });
}

function isPrivateV6(ip) {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::' || s === '::1') return true;
  if (s === '::') return true;
  // IPv4 兼容/映射地址（::ffff:a.b.c.d 与 ::a.b.c.d）
  const mapped = s.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  // 2001:db8::/32 文档用地址段
  if (s.startsWith('2001:db8')) return true;
  // 100::/64 discard-only
  if (s.startsWith('0100:') || s.startsWith('100:')) return true;
  if (s.startsWith('fe80')) return true;                       // 链路本地
  if (/^f[cd]/.test(s)) return true;                            // 唯一本地 fc00::/7
  const m = s.match(/^([0-9a-f]{1,4}):/);
  if (m) {
    const first = parseInt(m[1], 16);
    if ((first & 0xfe00) === 0xfc00) return true;
  }
  return false;
}

const ALLOW_LOCAL_FETCH = process.env.FEEDWATCH_ALLOW_LOCAL_FETCH === '1';

/** 仅这些 IP 会被放行 —— 必须是回环地址，不含任何真实内网段 */
const ALLOWED_LOCAL_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function localFetchAllowed() {
  return ALLOW_LOCAL_FETCH;
}

/**
 * ⚠️ 仅回环地址算「测试放行」。非回环的内网段（10.x/172.16-31.x/192.168.x）
 * 与链路本地地址（169.254.169.254 云元数据）**一律不放行**。
 */
function isLoopback(address) {
  return ALLOWED_LOCAL_IPS.has(String(address));
}

/**
 * ★ 测试专用放行：只在 `safeFetch` 的**最外层**短路，`assertHostIsPublic`
 * 一行都不改。
 *
 * ── 为什么放在最外层而不是 assertHostIsPublic 里 ──
 * 第一版（2026-10-17）把放行写成 `assertHostIsPublic` 里的
 * `if (ALLOW_LOCAL_FETCH && isLoopback(ip)) continue;`，
 * 后果是**改变了安全逻辑的控制流**：
 *   · `continue` 让私有地址混在返回的 ips 里，与正常路径无法区分
 *   · 加上 `const` 声明在使用点之后（TDZ），首次求值抛 ReferenceError
 *     中断了整个 assertHostIsPublic
 * 实测症状是「同一进程里A URL 的响应被串给 B URL」——
 * 看起来像生产级数据串用，实际是测试开关引入的。
 *
 * 现在：安全逻辑**零改动**，测试开关只在最外层决定
 * 「这次要不要做公网可达性校验」。误伤面最小，且生产完全不经过这段。
 *
 * ⚠️ 放行范围必须精确到回环：**第一版写「跳过全部检查」时，
 *    连 169.254.169.254 也被放行** —— SSRF 防线在测试环境下等于不存在，
 *    而项目里恰好有一条测试专门验「内网地址被拦截」，它立刻变红。
 */
function testBypassFor(hostname) {
  if (!ALLOW_LOCAL_FETCH) return null;
  const h = String(hostname).toLowerCase();
  // localhost / *.localhost / 裸回环 IP
  if (h === 'localhost' || h.endsWith('.localhost')) {
    return { address: '127.0.0.1', family: 4 };
  }
  if (isLoopback(h)) {
    return { address: h, family: net.isIP(h) === 6 ? 6 : 4 };
  }
  return null;
}

export function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) return isPrivateV6(ip);
  return true; // 非 IP 视为不安全
}

export class SsrfError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SsrfError';
    this.code = code;
  }
}

/** 校验 URL 基本合法性并返回规范化 URL */
export function assertHttpUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfError('URL 格式无效', 'invalid_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfError(`仅支持 http/https，收到 ${u.protocol}`, 'bad_protocol');
  }
  if (u.username || u.password) {
    throw new SsrfError('URL 不允许携带认证信息', 'credentials_in_url');
  }
  return u;
}

/** 解析主机名并校验全部 IP 均为公网地址 */
export async function assertHostIsPublic(hostname, resolver = dns) {  const literal = net.isIP(hostname);
  let ips;
  if (literal) {
    ips = [{ address: hostname, family: literal }];
  } else {
    try {
      ips = await resolver.lookup(hostname, { all: true });
    } catch (e) {
      throw new SsrfError(`域名解析失败：${hostname}（${e.code ?? e.message}）`, 'dns_failed');
    }
  }

  if (!ips || ips.length === 0) {
    throw new SsrfError(`无法解析主机名 ${hostname}`, 'dns_failed');
  }
  for (const ip of ips) {
    if (isPrivateAddress(ip.address)) {
      throw new SsrfError(
        `目标解析到私有/保留地址，已拒绝：${ip.address}`,
        'private_address'
      );
    }
  }
  return ips;
}

const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 判断 host 是否命中 NO_PROXY。
 *
 * 支持标准语义（curl / wget 一致）：
 *   · 逗号或空格分隔多条目
 *   · `*` 匹配全部
 *   · 前缀匹配：`example.com` 同时匹配 `a.example.com`（curl 行为）
 *   · 显式端口：仅该端口不代理（`example.com:8080`）
 *   · 前导点：`.example.com` 等价于 `example.com`
 *   · 大小写不敏感
 */
function matchesNoProxy(host, port, noProxy) {
  if (!noProxy) return false;
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  const list = noProxy.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  for (const raw of list) {
    if (raw === '*') return true;
    let entry = raw.toLowerCase();
    // 去掉协议前缀（有人会写成 http://example.com）
    entry = entry.replace(/^[a-z]+:\/\//, '');
    // 剥端口：仅 IPv6 需要特殊处理
    let entryHost = entry, entryPort = null;
    const portMatch = entry.match(/^(.*):(\d+)$/);
    if (portMatch && !entry.includes(']')) {
      entryHost = portMatch[1];
      entryPort = portMatch[2];
    }
    if (entryPort && String(port) !== entryPort) continue;
    entryHost = entryHost.replace(/^\./, '');
    if (!entryHost) continue;
    if (h === entryHost || h.endsWith(`.${entryHost}`)) return true;
  }
  return false;
}

/**
 * 解析出站代理配置。
 *
 * 背景：目标服务器 47.116.215.156 出网只通国内，境外 feed 全部超时。
 * `node:http` **不会**自动读取 HTTP_PROXY/HTTPS_PROXY（实测确认），
 * 所以光在环境变量里配代理是没用的，必须在这里显式把请求交给代理。
 *
 * 优先级：函数入参 proxyUrl > HTTPS_PROXY > HTTP_PROXY > ALL_PROXY
 * 形如 http://user:pass@host:port
 *
 * ★ NO_PROXY 支持：命中则返回 null（强制直连）。
 *   这不是安全漏洞而是可用性问题 —— 不遵守会让「本该直连的域名被强制走代理」，
 *   在代理不可达或该域名需内网直连时表现为无端超时。
 *   显式传入的 proxyUrl 仍优先于 NO_PROXY：调用方既然点名要代理，就尊重之。
 */
export function resolveProxy(proxyUrl, targetUrl) {
  const raw = proxyUrl
    || (String(targetUrl).startsWith('https:')
      ? (process.env.HTTPS_PROXY || process.env.https_proxy
         || process.env.HTTP_PROXY || process.env.http_proxy)
      : (process.env.HTTP_PROXY || process.env.http_proxy))
    || process.env.ALL_PROXY || process.env.all_proxy
    || '';
  if (!raw) return null;

  let u;
  try {
    // 补全协议头：环境变量常写成 "host:port" 而非完整 URL
    u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(u.protocol)) return null;

  const proxy = {
    href: u.href,
    host: u.hostname,
    port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
    protocol: u.protocol,
    auth: u.username
      ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`
      : null,
  };

  // 仅当代理来自环境变量时才应用 NO_PROXY（显式入参优先）
  if (!proxyUrl) {
    let target;
    try {
      target = new URL(targetUrl);
    } catch {
      return proxy;
    }
    const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
    if (matchesNoProxy(target.hostname, target.port || (target.protocol === 'https:' ? 443 : 80), noProxy)) {
      return null;   // 命中 → 直连
    }
  }

  return proxy;
}

/** 用已校验的 IP 发起单次请求。
 *
 * 两种模式：
 *  - 直连：连接锁定在已校验 IP（防 DNS rebinding）
 *  - 代理：CONNECT 到代理，再由代理连目标。此时 IP 锁定由代理侧的
 *    DNS 决定，我们仍对目标 hostname 做过一次本地校验，
 *    但**无法**约束代理如何解析 —— 这是代理模式固有的取舍。
 */
function requestOnce(url, {
  method = 'GET',
  headers = {},
  body = null,
  pinnedIp,
  timeoutMs,
  maxBytes,
  proxy = null,
}) {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const requestHeaders = { ...headers };

    let options;
    if (!proxy) {
      // —— 直连：把连接锁定在已校验的 IP（防 DNS rebinding）——
      //    Host 头与 TLS SNI 仍用原始域名，虚拟主机/CDN 不受影响。
      options = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: requestHeaders,
        lookup: (_h, opts, cb) => {
          const family = pinnedIp.family ?? net.isIP(pinnedIp.address);
          if (opts && opts.all) return cb(null, [{ address: pinnedIp.address, family }]);
          return cb(null, pinnedIp.address, family);
        },
        ...(isHttps ? { servername: url.hostname } : {}),
      };
    } else if (isHttps) {
      // —— HTTPS 走代理：先 CONNECT 开隧道，再在其上做 TLS 握手 ——
      options = {
        method,
        path: `${url.pathname}${url.search}`,
        // Host 头保持域名：隧道内的 SNI / 虚拟主机路由依赖它
        headers: { ...requestHeaders, host: `${url.hostname}:${url.port || 443}` },
        servername: url.hostname,          // SNI 用真实域名，证书校验才正确
        // ★ CONNECT 目标传 pinnedIp，由 openTunnel 用已校验 IP（TOCTOU 修复）
        createConnection: (_opts, oncreate) => openTunnel(url, proxy, pinnedIp, oncreate),
      };
    } else {
      // —— HTTP 走代理：请求行使用绝对 URI ——
      // ★ TOCTOU 修复：绝对 URI 的 host 换成【已校验 IP】，代理只能连我们批准的 IP；
      //   Host 头保持原始域名，供目标站点做虚拟主机路由。
      const port = url.port || 80;
      const pinnedAuthority = `${pinnedIp.address}:${port}`;
      options = {
        host: proxy.host,
        port: proxy.port,
        method,
        path: `${url.protocol}//${pinnedAuthority}${url.pathname}${url.search}`,
        headers: {
          ...requestHeaders,
          host: `${url.hostname}:${port}`,
          ...(proxy.auth ? { 'proxy-authorization': buildBasicAuth(proxy.auth) } : {}),
        },
      };
    }

    const req = mod.request(options, (res) => {
      const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
      const stream = decodeStream(res, enc);
      const chunks = [];
      let total = 0;
      let truncated = false;

      stream.on('data', (c) => {
        total += c.length;
        if (total > maxBytes) {
          chunks.push(c.subarray(0, c.length - (total - maxBytes)));
          truncated = true;
          stream.destroy();
          return;
        }
        chunks.push(c);
      });

      const finish = (err) => {
        if (err) { req.destroy(); return reject(err); }
        resolve({
          status: res.statusCode,
          headers: { ...res.headers },
          buffer: Buffer.concat(chunks),
          truncated,
        });
      };

      stream.on('end', () => finish());
      stream.on('close', () => { if (truncated) finish(); });
      stream.on('error', (e) => finish(e));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new SsrfError(`请求超时（>${timeoutMs}ms）：${url.hostname}`, 'timeout'));
    });
    req.on('error', (e) => reject(e));
    if (body) req.write(body);
    req.end();
  });
}

function buildBasicAuth(auth) {
  return 'Basic ' + Buffer.from(auth, 'utf8').toString('base64');
}

/**
 * 通过 HTTP 代理为 HTTPS 目标开一条 CONNECT 隧道，并在其上完成 TLS 握手。
 *
 * ★ TOCTOU 修复（2026-10-12，上线前安全审计）：
 *   原实现 CONNECT 到 `${url.hostname}:443`（域名），域名由**代理侧**再解析一次，
 *   而那次解析不受我们的 SSRF 校验约束 —— 于是「我们校验的 IP」与
 *   「请求实际发往的 IP」不是同一个，构成 TOCTOU 缺口。
 *
 *   现改为 CONNECT 到**已校验并锁定的 IP**，把校验与执行对齐：
 *     · CONNECT 目标 = pinnedIp.address:port   ← 已通过 assertHostIsPublic
 *     · SNI / Host   = url.hostname            ← 证书校验与虚拟主机路由依赖它，不变
 *   这样代理只能连「我们批准过的那个 IP」，无法借二次解析改道内网。
 *
 * 权衡说明：部分代理会拒绝 CONNECT 到 IP（要求域名形式）。
 * 那类代理下本次请求会失败（proxy_error），属可接受的降级 ——
 * 宁可抓不到，也不放行未校验的目标。
 *
 * Node 的 `createConnection(options, oncreate)` 约定是**回调式**：
 * 拿到隧道后调用 oncreate(null, tlsSocket)，出错则 oncreate(err)。
 */
function openTunnel(url, proxy, pinnedIp, oncreate) {
  // ★ CONNECT 目标必须是【已校验的 IP】而非域名 —— 这是 TOCTOU 修复的核心。
  //   target 出现在三处：path（请求行）、headers.host、错误消息，
  //   三处都必须用 IP，否则代理仍可自行解析域名改道内网。
  //   hostHeader 则保持域名，用于隧道内的 TLS SNI 与虚拟主机路由。
  const port = url.port || 443;
  const target = `${pinnedIp.address}:${port}`;
  const hostHeader = `${url.hostname}:${port}`;
  const req = http.request({
    host: proxy.host,
    port: proxy.port,
    method: 'CONNECT',
    path: target,
    headers: {
      host: target,
      ...(proxy.auth ? { 'proxy-authorization': buildBasicAuth(proxy.auth) } : {}),
    },
  });

  req.once('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      oncreate(new SsrfError(
        `代理拒绝 CONNECT ${target}：HTTP ${res.statusCode}`, 'proxy_error'
      ));
      return;
    }
    // SNI 仍用原始域名：证书校验与虚拟主机/CDN 路由依赖它，不可改成 IP
    const secured = tls.connect({ socket, servername: url.hostname });
    secured.once('secureConnect', () => oncreate(null, secured));
    secured.once('error', (e) => oncreate(e));
  });
  req.once('error', (e) => oncreate(e));
  req.end();
}

function decodeStream(res, encoding) {
  if (encoding.includes('gzip')) return res.pipe(zlib.createGunzip());
  if (encoding.includes('deflate')) return res.pipe(zlib.createInflate());
  if (encoding.includes('br')) return res.pipe(zlib.createBrotliDecompress());
  return res;
}

/** 常见中文编码别名 → TextDecoder 支持的标签 */
const CHARSET_ALIASES = {
  'utf8': 'utf-8',
  'gb2312': 'gbk',        // WHATWG 规定 gb2312 一律按 gbk 解
  'gb_2312-80': 'gbk',
  'gbk': 'gbk',
  'gb18030': 'gb18030',
  'big5': 'big5',
  'big5-hkscs': 'big5',
  'iso-8859-1': 'windows-1252',
  'us-ascii': 'windows-1252',
};

/** 优先用 HTTP 头里的 charset，其次嗅探 XML 声明 */
function detectCharset(buffer, contentType) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  const head = buffer.subarray(0, 256).toString('latin1');
  const fromXml = /encoding=["']([\w-]+)["']/i.exec(head)?.[1];
  const raw = (fromHeader || fromXml || 'utf-8').toLowerCase();
  const label = CHARSET_ALIASES[raw] ?? raw;
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return 'utf-8';
  }
}

function decodeBuffer(buffer, contentType) {
  const charset = detectCharset(buffer, contentType);
  let text;
  try {
    text = new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    text = buffer.toString('utf8');
  }
  // 去掉 UTF-8 BOM，否则首字节会让 JSON/XML 探测失败
  return text.replace(/^﻿/, '');
}

/**
 * 带完整 SSRF 防护的 fetch
 * - 每跳重定向重新校验
 * - 10s 超时 · maxBytes 大小上限 · 最多 3 跳
 * - 自动解压 gzip/deflate/br · 自动识别 UTF-8/GBK/Big5 等编码
 */
export async function safeFetch(rawUrl, {
  timeoutMs = 10_000,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = MAX_REDIRECTS,
  userAgent = 'FeedWatch/0.1 (+change-monitoring)',
  resolver = dns,
  method = 'GET',
  headers: extraHeaders = {},
  body = null,
  proxyUrl = null,
} = {}) {
  let currentUrl = assertHttpUrl(rawUrl).toString();
  const redirects = [];
  // 每一跳都重新解析代理：重定向可能从 https 跳到 http，反之亦然
  const perHopProxy = (u) => resolveProxy(proxyUrl, u.href);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = new URL(currentUrl);
    // ★ 测试放行只在这里短路，assertHostIsPublic 本身零改动（见 testBypassFor 说明）
    const bypass = testBypassFor(u.hostname);
    const ips = bypass ? [bypass] : await assertHostIsPublic(u.hostname, resolver);
    const pinnedIp = ips[0];
    const proxy = perHopProxy(u);

    const headers = {
      'user-agent': userAgent,
      accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, application/json;q=0.8, */*;q=0.5',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...extraHeaders,
    };
    if (body) headers['content-length'] = String(Buffer.byteLength(body));

    const res = await requestOnce(u, {
      method, headers, body, pinnedIp, timeoutMs, maxBytes, proxy,
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.location;
      if (!location) throw new SsrfError('重定向缺少 Location 头', 'bad_redirect');
      currentUrl = new URL(location, currentUrl).toString();
      redirects.push(new URL(currentUrl).origin + '/…');
      assertHttpUrl(currentUrl);   // 下一跳重新走完整校验
      continue;
    }

    const text = decodeBuffer(res.buffer, res.headers['content-type']);
    return {
      status: res.status,
      headers: res.headers,
      body: text,
      truncated: res.truncated,
      finalUrl: currentUrl,
      redirects,
      resolvedIp: pinnedIp.address,
      /**
       * 本次是否经出网代理。
       *
       * ★ TOCTOU 修复后的语义：代理模式下 CONNECT/绝对 URI 的目标已是
       *   **已校验的 pinnedIp**，所以 resolvedIp 确实是「连接到的 IP」，
       *   不再是误导性字段。viaProxy 保留用于排障时区分两种模式
       *   （直连由我们 lookup 钉 IP；代理由我们指定 CONNECT 目标）。
       */
      viaProxy: Boolean(proxy),
    };
  }

  throw new SsrfError(`重定向次数超过 ${maxRedirects}`, 'too_many_redirects');
}

export const __testing = {
  isPrivateV4, isPrivateV6, v4ToInt, PRIVATE_V4,
  detectCharset, decodeBuffer, CHARSET_ALIASES,
  resolveProxy,
};