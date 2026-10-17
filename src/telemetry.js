/**
 * 运营事件记录（append-only JSONL，零依赖）
 *
 * ══════════════════════════════════════════════════════════════
 * ⚠️ 本模块的硬边界：只记录「计数类」事实，绝不记录客户数据内容
 * ══════════════════════════════════════════════════════════════
 *
 * 隐私政策向客户承诺的是：「监控点URL、feed 内容、检出的变更，全部只在内存中」。
 * 这个承诺必须严守 —— 它是 FeedWatch 相对竞品的**可验证卖点**
 * （隐私政策写的是可核对的代码事实，不是「我们非常重视您的隐私」这种模板）。
 *
 * 所以本模块**明确不记录**：
 *   ✗ 监控点 URL        ✗ feed 正文 /标题 / 作者
 *   ✗ 检出的变更内容     ✗ 用户邮箱
 *   ✗ API Key（明文或哈希）
 *   ✗ 请求头 / User-Agent / IP
 *
 * 本模块**只记录**：
 *   ✓ 事件类型          ✓ Key 的随机 id（如 key_a1b2c3d4）
 *   ✓ 时间戳            ✓ 计数（已有几个监控点、失败原因分类）
 *   ✓ 事件自带的分类标签（如 fail_reason=not_feed）
 *
 * ── 为什么用 JSONL 而不是数据库 ──
 * 验证期要的是「0 依赖、能立刻查」，不是查询能力。
 * 每天一个文件，`grep` 就能算账，不需要引入任何写入依赖。
 * 未来真要复杂查询再迁移 —— 那时数据量也说明该迁了。
 *
 * ── 为什么必须落盘 ──
 * 「有几个人卡在 5 个监控点上限上」是付费潜力的**唯一直接信号**，
 * 而内存数据重启即清空 —— 不落盘等于这个信号不存在。
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.FEEDWATCH_DATA_DIR ?? '/opt/feedwatch/data';
const ENABLED = process.env.FEEDWATCH_TELEMETRY !== 'off';

/** 允许记录的事件类型白名单 —— 新增事件必须先加到这里 */
const ALLOWED_EVENTS = new Set([
  'key_issued',          // 自助领了 Key
  'monitor_created',     // 成功建了监控点
  'limit_hit',           // ⭐ 撞到配额上限 =唯一的付费信号
  'create_failed',       // 建监控点失败（含原因分类）
  'check_failed',        // 检查失败（含原因分类）
  'api_429',             // 其他限流命中
]);

/** 失败原因白名单 —— 只允许粗分类，不允许带 URL 或正文 */
const ALLOWED_REASONS = new Set([
  'not_feed', 'http_error', 'timeout', 'too_large', 'blocked',
  'invalid_url', 'dns_fail', 'unknown',
]);

/**
 * 记录一条事件。任何字段缺失或非法都**静默丢弃**，绝不影响主流程。
 *
 * 设计取舍：这里刻意**不抛异常** —— 监控失败不能拖垮用户请求。
 * 但也不能静默到无法排查，所以启动时会打印一次本模块是否启用。
 *
 * @param {string} event 事件类型，必须在 ALLOWED_EVENTS 内
 * @param {object} data  附加字段，只允许以下 key：
 *                        keyId、count、reason、tier、source
 */
export function track(event, data = {}) {
  if (!ENABLED) return;
  if (!ALLOWED_EVENTS.has(event)) return;

  const row = {
    ts: new Date().toISOString(),
    ev: event,
    // keyId 是随机 id（key_xxxxxxxx），不含任何可识别信息
    k: typeof data.keyId === 'string' && /^key_[a-f0-9]{8}$/.test(data.keyId) ? data.keyId : null,
    c: Number.isInteger(data.count) ? data.count : null,
    r: typeof data.reason === 'string' && ALLOWED_REASONS.has(data.reason) ? data.reason : null,
    s: typeof data.source === 'string' ? data.source.slice(0, 16) : null,
  };

  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const day = row.ts.slice(0, 10);
    appendFileSync(join(DATA_DIR, `events-${day}.jsonl`), `${JSON.stringify(row)}\n`, 'utf8');
  } catch (e) {
    // ⚠️ 写盘失败必须**可见** —— 否则就是「声称在记录，实际什么都没记」，
    //   那正是今天反复修的那类缺陷。实测踩到过：目录权限不足时静默跳过，
    //   统计端点永远返回 0，而没人知道。
    //
    //   做法：启动后第一次失败打一行 stderr（进 systemd journal），
    //   之后每 200 次汇总一次，避免刷屏。
    failures += 1;
    if (failures === 1 || failures % 200 === 0) {
      console.error(
        `[feedwatch] 运营事件写入失败（已失败 ${failures} 次）：`
        + `${DATA_DIR} → ${e.message}。付费信号将无法统计。`,
      );
    }
  }
}

let failures = 0;

/**
 * 汇总统计（供 GET /v1/stats 用）
 *
 * ⚠️ 这里返回的是**聚合计数**，不含任何 Key id 列表 ——
 *    即使是引导密钥也不返回明细，避免日志文件本身成为泄露源。
 */
export function summarize() {
  const days = [];
  try {
    for (const f of readdirSync(DATA_DIR)) {
      if (/^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) days.push(f);
    }
  } catch {
    return emptySummary();
  }
  days.sort();
  if (days.length === 0) return emptySummary();

  const acc = {
    ...emptySummary(),
    days: days.length,
    first_day: days[0].replace('events-', '').replace('.jsonl', ''),
    last_day: days.at(-1).replace('events-', '').replace('.jsonl', ''),
  };
  const wallKeys = new Set();

  for (const f of days) {
    let content = '';
    try { content = readFileSync(join(DATA_DIR, f), 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      acc.events_total += 1;
      if (row.ev === 'key_issued') { acc.keys_issued += 1; if (row.k) acc.unique_keys.add(row.k); }
      else if (row.ev === 'monitor_created') { acc.monitors_created += 1; }
      else if (row.ev === 'limit_hit') {
        acc.limit_hits += 1;
        if (row.k) wallKeys.add(row.k);
      } else if (row.ev === 'create_failed') {
        acc.create_failed += 1;
        acc.fail_reasons[row.r ?? 'unknown'] = (acc.fail_reasons[row.r ?? 'unknown'] ?? 0) + 1;
      } else if (row.ev === 'check_failed') {
        acc.check_failed += 1;
        acc.fail_reasons[row.r ?? 'unknown'] = (acc.fail_reasons[row.r ?? 'unknown'] ?? 0) + 1;
      } else if (row.ev === 'api_429') {
        acc.other_429 += 1;
        const k2 = row.s ?? 'unknown';
        acc.r429_reasons[k2] = (acc.r429_reasons[k2] ?? 0) + 1;
      }
    }
  }

  acc.unique_users = acc.unique_keys.size;
  acc.limit_hit_users = wallKeys.size;
  delete acc.unique_keys;

  // ⭐ 最关键的一个数字：撞过墙的人数（= 付费潜力的直接信号）
  acc.conversion_signal = {
    users_issued_key: acc.unique_users,
    users_hit_limit: acc.limit_hit_users,
    // 撞墙率：有Key 的人里有多少撞了上限
    hit_rate: acc.unique_users > 0
      ? Math.round((acc.limit_hit_users / acc.unique_users) * 100) / 100
      : null,
    // 读法：> 0 说明确实有人想要更多监控点 → 支持加付费档
    //       = 0 说明 5 个可能太宽松，或产品本身没被需要
    verdict: acc.limit_hit_users === 0
      ? (acc.unique_users === 0 ? '尚无用户' : '有用户但无人撞墙 → 5 个可能太宽松')
      : (acc.limit_hit_users >= 3 ? '至少 3 人撞墙 → 付费档值得上线' : '有人撞墙 → 值得推付费档'),
  };
  return acc;
}

function emptySummary() {
  return {
    days: 0,
    first_day: null,
    last_day: null,
    events_total: 0,
    unique_users: 0,
    keys_issued: 0,
    unique_keys: new Set(),
    monitors_created: 0,
    limit_hits: 0,
    limit_hit_users: 0,
    create_failed: 0,
    check_failed: 0,
    other_429: 0,
    fail_reasons: {},
    r429_reasons: {},
    conversion_signal: null,
  };
}

/**
 * ⚠️ 自检：确保事件白名单里的类型都有实际调用点。
 * 没有被调用的类型会出现在 unused 里 —— 那说明文档吹了功能。
 */
export function declaredButUnused() {
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  return [...ALLOWED_EVENTS].filter((e) => !src.includes(`'${e}'`));
}