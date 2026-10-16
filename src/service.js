/**
 * 核心服务：调度抓取、比对、推送
 */

import { randomUUID, createHash } from 'node:crypto';
import { safeFetch } from './security/ssrf.js';
import { detectAndParse } from './parser/feeds.js';
import { Snapshot, diffSnapshots, filterByKeywords } from './diff/engine.js';
import { buildPayload, deliverAll } from './notify/deliver.js';

const INTERVALS = new Set([900, 3600, 21600]);

/** feed 体积上限：与 safeFetch 的 maxBytes 保持一致 */
const MAX_FEED_BYTES = 10 * 1024 * 1024;

/** 内存存储（MVP 阶段用；生产换 SQLite/Postgres） */
export class MemoryStore {
  constructor() {
    this.monitors = new Map();
    this.snapshots = new Map();
    this.apikeys = new Map();
  }

  createMonitor({ url, name, intervalSeconds, keywords, apiKeyId }) {
    const id = `mon_${randomUUID().slice(0, 12)}`;
    const m = {
      id,
      url,
      name: name ?? url,
      intervalSeconds: INTERVALS.has(intervalSeconds) ? intervalSeconds : 21600,
      keywords: Array.isArray(keywords) ? keywords.slice(0, 20) : [],
      apiKeyId: apiKeyId ?? null,
      // status 只表达用户的调度意图：active | paused。
      // 健康状况看 errorCount / lastCheckOk / lastError；
      // 自动熔断看 trippedByCircuitBreaker。三者刻意分开，避免互相覆盖。
      status: 'active',
      createdAt: new Date().toISOString(),
      lastCheckedAt: null,
      lastChangeAt: null,
      nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
      errorCount: 0,
      lastError: null,
      lastCheckOk: null,
      trippedByCircuitBreaker: false,
      channels: [],
    };
    this.monitors.set(id, m);
    return m;
  }

  getMonitor(id) { return this.monitors.get(id); }
  listMonitors() { return [...this.monitors.values()]; }
  /** 删除监控点并回收其快照 */
  deleteMonitor(id) {
    this.snapshots.delete(id);   // 快照与监控点生命周期一致，避免长期运行内存泄漏
    return this.monitors.delete(id);
  }

  updateMonitor(id, patch) {
    const m = this.monitors.get(id);
    if (!m) return null;
    if (patch.intervalSeconds != null && INTERVALS.has(patch.intervalSeconds)) {
      m.intervalSeconds = patch.intervalSeconds;
    }
    if (Array.isArray(patch.keywords)) m.keywords = patch.keywords.slice(0, 20);
    if (patch.name != null) m.name = String(patch.name).slice(0, 100);
    if (patch.status === 'paused' || patch.status === 'active') {
      m.status = patch.status;
      // 用户显式重新启用时，清掉熔断标记与失败计数，
      // 否则 errorCount 仍 ≥ 阈值，schedule() 会立刻再次熔断，用户永远无法恢复。
      if (patch.status === 'active') {
        m.trippedByCircuitBreaker = false;
        m.errorCount = 0;
        m.lastError = null;
      }
    }
    if (Array.isArray(patch.channels)) m.channels = patch.channels;
    return m;
  }

  getSnapshot(id) { return this.snapshots.get(id); }
  saveSnapshot(id, snap) { this.snapshots.set(id, snap); }
  /** ★ 删除监控点时一并回收快照，否则 snapshots Map 永久增长（内存泄漏） */
  deleteSnapshot(id) { return this.snapshots.delete(id); }

  /**
   * 签发一把 API Key。
   *
   * ⚠️ parentId（2026-10-16 补，D9）：
   *   原本只记 { id, label, createdAt }，**不记是谁签发的**，
   *   导致客户 Key 签出的 Key 与内部签出的在数据上完全无法区分，
   *   配额也无法正确归属。追溯 parentId 链可解决这两点。
   *
   * @param {string} label     人读标签
   * @param {object} [opts]
   * @param {string} [opts.parentId]  签发者的 Key id；缺省视为引导密钥（根）
   * @param {boolean} [opts.isBootstrap] 是否为引导密钥（根 Key，不可被吊销）
   */
  createApiKey(label, { parentId = null, isBootstrap = false } = {}) {
    const raw = `fw_${randomUUID().replace(/-/g, '')}`;
    const id = `key_${randomUUID().slice(0, 8)}`;
    const hash = createHash('sha256').update(raw).digest('hex');
    this.apikeys.set(hash, {
      id,
      label: label ?? '',
      createdAt: new Date().toISOString(),
      parentId,          // ← 签发者；null = 根 Key
      isBootstrap,       // ← 仅引导密钥为 true，吊销时必须保护
    });
    return { id, raw };
  }

  /**
   * 由环境变量注入一把已知明文的引导密钥。
   *
   * 上线前审计修复：createApiKey 原本只能在需要鉴权的 /v1/apikeys 里调用，
   * 而该端点又要求已有 key —— 首次部署无法获得任何凭据，鉴权区形同虚设
   * （实际上会诱使人把 /mcp 也放开，那就成了匿名接口）。
   *
   * ⚠️ isBootstrap=true（D9）：引导密钥是**所有 Key 的根**，
   *   既不能被吊销（否则把自己锁死），也是唯一允许签发 Key 的凭据（D8）。
   */
  seedApiKey(raw, label = 'bootstrap') {
    if (!raw || typeof raw !== 'string') return null;
    const hash = createHash('sha256').update(raw).digest('hex');
    if (this.apikeys.has(hash)) return null;
    const id = `key_${randomUUID().slice(0, 8)}`;
    this.apikeys.set(hash, {
      id,
      label,
      createdAt: new Date().toISOString(),
      parentId: null,     // 根
      isBootstrap: true,  // ← 保护标记
    });
    return { id };
  }

  findApiKey(raw) {
    if (!raw) return null;
    const hash = createHash('sha256').update(raw).digest('hex');
    return this.apikeys.get(hash) ?? null;
  }

  /**
   * 追溯到根 Key 的 id（D9）。
   *
   * 为什么需要：限流桶若按「当前 Key」分桶，客户用 Key A 签出 B、
   * 再用 B 签出 C…，每个新 Key 都有独立桶 → **配额被指数放大**。
   * 按根 Key 分桶后，无论客户怎么签发，都共用同一个桶。
   *
   * 引导密钥自身即根（parentId 为 null）。
   * 防御：链路最多回溯 16 层（防环形引用导致死循环），
   * 遇到断链（parentId 指向不存在的 Key）时以当前 Key 为根，不抛错。
   */
  resolveRootKeyId(keyId) {
    let cur = keyId;
    for (let i = 0; i < 16; i++) {
      const rec = this.findApiKeyById(cur);
      if (!rec || !rec.parentId) return cur;   // 自己是根，或断链
      cur = rec.parentId;
    }
    return cur;
  }

  /** 按 id 查 Key 记录（明文不可得，只返回元信息） */
  findApiKeyById(keyId) {
    for (const rec of this.apikeys.values()) if (rec.id === keyId) return rec;
    return null;
  }

  /** 按归属统计监控点数量 */
  countByOwner(apiKeyId) {
    let n = 0;
    for (const m of this.monitors.values()) if (m.apiKeyId === apiKeyId) n++;
    return n;
  }
}

/** 单次抓取 + 解析 + 比对 */
export async function checkOnce(url, store, prevSnapshot) {
  const res = await safeFetch(url);
  if (res.status < 200 || res.status >= 300) {
    throw Object.assign(new Error(`上游返回 HTTP ${res.status}`), { status: res.status });
  }
  const parsed = detectAndParse(res.body, res.headers['content-type'] ?? '');

  // ★ 体积超限被静默截断时，必须拒绝这份快照。
  //   截断的 feed 只含前 N 条，若当成真实快照保存：
  //     本轮 → 其余条目全被误报为「删除」
  //     下轮恢复正常 → 同一批条目又全被误报为「新增」
  //   用户会收到 2N 条垃圾通知，且监控点被污染到无法自愈。
  if (res.truncated) {
    throw Object.assign(
      new Error(`响应体超过体积上限已被截断，本轮跳过以免误报（上限 ${MAX_FEED_BYTES} 字节）`),
      { code: 'truncated' }
    );
  }

  const snap = new Snapshot(url, parsed, new Date().toISOString());
  const result = diffSnapshots(prevSnapshot ?? null, snap);
  return { ...result, url, format: parsed.format, feedTitle: parsed.title, snapshot: snap };
}

export class MonitorService {
  /**
   * @param {object} store
   * @param {{maxMonitors?:number, errorThreshold?:number}} [opts]
   */
  constructor(store, { maxMonitors = Infinity, errorThreshold = 10 } = {}) {
    this.store = store;
    this.timers = new Map();
    /** 正在检查中的监控点 id —— 防止调度器与手动 /check 并发重入 */
    this.inFlight = new Set();
    this.maxMonitors = maxMonitors;
    /**
     * 连续失败熔断阈值。
     *
     * 上线前审计发现：调度器在 checkMonitor 抛错后无条件重排
     * （catch {} 吞掉异常），errorCount 只增不减且从不参与决策。
     * 指向已下线域名的监控点会永远每 15 分钟重试一次，没有退避也没有上限。
     */
    this.errorThreshold = errorThreshold;
  }

  /**
   * 检查单个监控点。
   *
   * ★ 修复记录 1（同监控点并发重入）：
   *   调度器 tick 与用户手动 POST /v1/monitors/:id/check 可以同时打到同一个监控点。
   *   原实现没有互斥：两次 checkOnce 并发跑，后写的 snapshot 覆盖先写的，
   *   而两次都基于**同一份 prev** 算 diff —— 结果是变更被重复通知一次、
   *   或一次变更被后一个请求「吃掉」而永远不推送。现用 inFlight 去重：
   *   已有检查在跑时直接返回 skipped，不重复抓取。
   *
   * ★ 修复记录 2（投递失败即永久丢变更）：
   *   原顺序是「先 saveSnapshot 推进基线 → 再 deliverAll 推送」。
   *   一旦 deliverAll 抛错，基线已经推进，那批变更**再也不会被重新检测到**，
   *   用户永久收不到这条通知（静默丢数据，与 Bug 1/2 同族）。
   *   现改为：先把投递跑完并**兜住所有异常**，无论成败都推进基线
   *   （否则会无限重复推送同一条变更，变成另一种骚扰），
   *   但把投递结果如实记进 lastDeliveryResult，供上层观测与补偿。
   */
  async checkMonitor(monitor) {
    if (!monitor?.id) return { error: '监控点无效', code: 'invalid_monitor' };
    if (this.inFlight.has(monitor.id)) {
      return { skipped: true, reason: 'check_in_flight' };
    }
    this.inFlight.add(monitor.id);
    try {
      return await this._checkMonitor(monitor);
    } finally {
      this.inFlight.delete(monitor.id);   // 成功/失败都必须释放，否则监控点永久卡死
    }
  }

  async _checkMonitor(monitor) {
    const prev = this.store.getSnapshot(monitor.id);
    let result;
    try {
      result = await checkOnce(monitor.url, this.store, prev);
    } catch (err) {
      // 抓取/解析失败：只更新错误状态，绝不改动 snapshot（基线保持不变，
      // 否则一次网络抖动就会把所有条目误判为「新增」）
      monitor.errorCount = (monitor.errorCount ?? 0) + 1;
      monitor.lastError = String(err.message ?? err).slice(0, 300);
      monitor.lastCheckedAt = new Date().toISOString();
      // ⚠️ 绝不在这里写 monitor.status —— status 是「调度意图」(active/paused)，
      //   不是「健康状态」。写成 'error' 会让 tick 的守卫
      //   `if (m.status !== 'active')` 判定为已停用，直接清掉定时器，
      //   于是**一次网络抖动就让监控点永久静默失效**（实测复现）。
      //   健康状况由 errorCount / lastError / lastCheckOk 表达。
      monitor.lastCheckOk = false;
      return { error: err.message, code: err.code ?? null };
    }

    monitor.lastCheckedAt = new Date().toISOString();
    monitor.lastFormat = result.format;
    monitor.errorCount = 0;
    monitor.lastError = null;
    monitor.lastCheckOk = true;

    const filtered = filterByKeywords(result.changes, monitor.keywords);

    if (filtered.length > 0 && monitor.channels?.length > 0) {
      const payload = buildPayload(monitor, filtered);
      try {
        const deliveries = await deliverAll(monitor.channels, payload);
        monitor.lastDeliveryAt = new Date().toISOString();
        monitor.lastDeliveryResult = deliveries;
        monitor.lastChangeAt = payload.detected_at;
      } catch (err) {
        // deliverAll 内部已逐通道兜错，走到这说明是 payload 构造/序列化之类的问题。
        // 绝不能让它冒泡：冒泡会让本轮 check 整体失败，而基线若不推进又会重复推送。
        monitor.lastDeliveryAt = new Date().toISOString();
        monitor.lastDeliveryResult = [{ delivered: false, error: String(err.message ?? err).slice(0, 300) }];
        monitor.lastError = `通知投递异常：${String(err.message ?? err).slice(0, 200)}`;
      }
    }

    // 基线最后推进：此时本轮结果已确定（无论投递成败），不会漏也不会重复
    this.store.saveSnapshot(monitor.id, result.snapshot);

    return {
      changed: filtered.length > 0,
      format: result.format,
      change_count: filtered.length,
      raw_change_count: result.changes.length,
      reason: result.reason,
    };
  }

  /**
   * 为监控点安排下一次检查。
   *
   * ⚠️ 修复记录（定时器语义错误 —— 表现为「超额抓取 360 倍」）：
   *   原实现里 `initial` 同时扮演两个互相矛盾的角色：
   *     · 首次调度：希望「尽快跑一次」（60s 内）
   *     · tick 结束后续期：希望「按 intervalSeconds 等下一次」（900/3600/21600s）
   *   而 `Math.min(..., 60_000)` 这个上限对两者都生效，于是**续期也被压成 60s**：
   *   实测 intervalSeconds=21600（6h）时，实际每 60s 就抓一次上游。
   *   后果：① 对目标站点的请求量放大 360 倍（爬取不礼貌、极易被封 IP）；
   *        ② 用户以为 6h 检查一次，实际 1 分钟一次，计费与配额口径全错；
   *        ③ `/v1/usage` 声明的 checks_per_day=50 形同虚设。
   *
   *   现拆成两个参数：首次/恢复调度用 firstDelayMs（短），
   *   tick 内的正常续期用 intervalSeconds * 1000（长）。
   */
  schedule(monitor, { firstDelayMs = null } = {}) {
    if (!monitor) return;
    this.stop(monitor.id);

    // 熔断：连续失败过多则自动挂起。上线前审计发现 errorCount 只增不减
    // 且从不参与任何决策 —— 指向已下线域名的监控点会永远按间隔重试。
    //
    // ⚠️ 用独立的 trippedByCircuitBreaker 标记，而不是把 status 写成 'paused'：
    //   status 只能表达**用户的调度意图**（active/paused）。若熔断借用它，
    //   就无法区分「用户主动暂停」与「系统自动熔断」，二者恢复路径不同，
    //   混在一起还会让手动 PATCH status=active 静默解除熔断（防线形同虚设）。
    if ((monitor.errorCount ?? 0) >= this.errorThreshold) {
      monitor.trippedByCircuitBreaker = true;
      monitor.lastError =
        `连续失败 ${monitor.errorCount} 次，已自动挂起；上游恢复后 PATCH status=active 重新启用`;
      // 仍然按「挂起」处理，不再排下一次定时器
      monitor.status = 'paused';
      return;
    }
    // 未达阈值则解除熔断标记（成功一次即恢复，由 _checkMonitor 清零 errorCount）
    if (monitor.trippedByCircuitBreaker && (monitor.errorCount ?? 0) < this.errorThreshold) {
      monitor.trippedByCircuitBreaker = false;
    }

    const tick = async () => {
      const m = this.store.getMonitor(monitor.id);
      // 监控点可能已被删除 / 暂停：必须清理 timer 条目，否则 timers Map 无限泄漏
      if (!m || m.status !== 'active') {
        this.stop(monitor.id);
        return;
      }
      try {
        await this.checkMonitor(m);
      } catch { /* 单次失败不影响调度；熔断由 errorCount 负责 */ }
      // 取最新 monitor（checkMonitor 可能改过 intervalSeconds），再按真实间隔续期
      const cur = this.store.getMonitor(monitor.id);
      if (!cur || cur.status !== 'active') { this.stop(monitor.id); return; }
      cur.nextCheckAt = new Date(Date.now() + cur.intervalSeconds * 1000).toISOString();
      // 连续失败时叠加指数退避（上限 6 小时），成功一次即由 checkMonitor 清零
      const fails = cur.errorCount ?? 0;
      const backoff = fails > 0 ? Math.min(fails * fails * 60_000, 6 * 3600_000) : 0;
      this.schedule(cur, { firstDelayMs: cur.intervalSeconds * 1000 + backoff });
    };

    let delay;
    if (firstDelayMs != null) {
      delay = firstDelayMs;
    } else {
      const planned = new Date(monitor.nextCheckAt ?? Date.now()).getTime() - Date.now();
      // 首次/重启恢复：钳制在 5s~60s，避免「计划已过期」导致立即风暴式重抓
      delay = Number.isFinite(planned) && planned > 0
        ? Math.min(Math.max(planned, 5_000), 60_000)
        : 60_000;
    }
    this.timers.set(monitor.id, setTimeout(tick, delay));
    monitor.nextCheckAt = new Date(Date.now() + delay).toISOString();
  }

  stop(id) {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
  }

  startAll() {
    for (const m of this.store.listMonitors()) {
      if (m.status === 'active') this.schedule(m);
    }
  }

  stopAll() {
    for (const id of [...this.timers.keys()]) this.stop(id);
  }
}

export { INTERVALS };