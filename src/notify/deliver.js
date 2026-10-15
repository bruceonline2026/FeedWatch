/**
 * 通知投递：Webhook（HMAC 签名）+ 邮件 + Slack/Discord
 *
 * 差异化点：竞品 Proxycurl 明确「不提供 HTTP push，只能让消费方轮询」，
 * 文档自认这会增加延迟与工程开销。本模块原生 push，签名可验证。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { safeFetch } from '../security/ssrf.js';

export function signPayload(rawBody, secret) {
  const sig = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return `sha256=${sig}`;
}

/** 供客户参考的验签代码（Node 版） */
export function verify(rawBody, headerSignature, secret) {
  const expected = signPayload(rawBody, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(headerSignature ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 构造推送载荷 */
export function buildPayload(monitor, changes, detectedAt = new Date().toISOString()) {
  return {
    monitor_id: monitor.id,
    monitor_name: monitor.name ?? monitor.url,
    url: monitor.url,
    format: monitor.lastFormat ?? null,
    detected_at: detectedAt,
    change_count: changes.length,
    changes: changes.map((c) => ({
      change_type: c.type,
      item_id: c.item_id,
      title: c.item?.title ?? '',
      link: c.item?.link ?? '',
      published_at: c.item?.publishedAt ?? '',
      diff: c.diff ?? [],
    })),
  };
}

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 5000, 15000];

/**
 * POST JSON 到目标地址。
 *
 * ⚠️ 走 safeFetch 而不是裸 fetch —— webhook URL 由用户提交，
 *    必须保留 SSRF 防护（否则可借我们的服务器探测内网）。
 */
async function postJson(url, body, headers = {}) {
  const raw = JSON.stringify(body);
  const { __secret, ...h } = headers;

  // ★ 上线前审计修复：旧实现是 `__secret ?? 'no-secret'`。
  //   客户端未配置 secret 时会拿字面量 "no-secret" 当 HMAC 密钥 —— 这是
  //   公开可猜的常量，任何拿到流量的人都能伪造合法签名，签名形同虚设。
  //   现在没有 secret 就不签名，让客户端能明确区分「未配置」而非误以为已验签。
  const hasSecret = typeof __secret === 'string' && __secret.length > 0;
  if (!hasSecret) {
    console.warn('[feedwatch] webhook 通道未配置 secret，将不发送签名头');
  }
  const sig = hasSecret ? signPayload(raw, __secret) : '';

  return safeFetch(url, {
    method: 'POST',
    body: raw,
    maxBytes: 256 * 1024,
    headers: {
      'content-type': 'application/json',
      ...(hasSecret ? { 'x-feedwatch-signature': sig } : {}),
      'x-feedwatch-event': 'feed.changed',
      ...h,
    },
  });
}

/**
 * 投递到单个通道，失败自动重试
 * @returns {{delivered:boolean, attempts:number, status?:number, error?:string}}
 */
export async function deliver(channel, payload) {
  const attemptsLog = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (channel.type === 'webhook') {
        const r = await postJson(channel.url, payload, { __secret: channel.secret });
        if (r.status >= 200 && r.status < 300) {
          return { delivered: true, attempts: attempt, status: r.status };
        }
        throw new Error(`HTTP ${r.status}`);
      }

      if (channel.type === 'slack' || channel.type === 'discord') {
        const text = formatText(payload);
        const r = await postJson(channel.url, {
          text,
          content: text,
          ...(channel.type === 'discord' ? { username: 'FeedWatch' } : {}),
        });
        if (r.status >= 200 && r.status < 300) {
          return { delivered: true, attempts: attempt, status: r.status };
        }
        throw new Error(`HTTP ${r.status}`);
      }

      throw new Error(`不支持的通道类型：${channel.type}`);
    } catch (err) {
      attemptsLog.push({ attempt, error: err.message });
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS[attempt - 1] ?? 3000);
      }
    }
  }
  return { delivered: false, attempts: MAX_ATTEMPTS, error: JSON.stringify(attemptsLog) };
}

function formatText(p) {
  const lines = [
    `*FeedWatch 变更通知*`,
    `监控点：${p.monitor_name ?? p.url}`,
    `变更数：${p.change_count}`,
    `时间：${p.detected_at}`,
    '',
  ];
  for (const c of p.changes.slice(0, 10)) {
    const tag = { added: '新增', modified: '修改', removed: '删除' }[c.change_type] ?? c.change_type;
    lines.push(`• [${tag}] ${c.title || c.item_id}`);
    if (c.diff?.length) {
      for (const d of c.diff.slice(0, 3)) {
        if (d.old !== undefined) lines.push(`    ${d.field}：${trunc(d.old)} → ${trunc(d.new)}`);
        else lines.push(`    ${d.field} 已变化`);
      }
    }
    if (c.link) lines.push(`    ${c.link}`);
  }
  if (p.changes.length > 10) lines.push(`… 还有 ${p.changes.length - 10} 条`);
  return lines.join('\n');
}

const trunc = (s, n = 80) => {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 投递给监控点的全部通道，汇总结果 */
export async function deliverAll(channels, payload) {
  return Promise.all(channels.map(async (ch) => ({
    channel: ch.type,
    ...(await deliver(ch, payload)),
  })));
}

export const __testing = { formatText, BACKOFF_MS, MAX_ATTEMPTS };