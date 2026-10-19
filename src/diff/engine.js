/**
 * 变更检测：哈希粗筛 + 结构化字段级 diff
 *
 * 两层设计的原因（成本关键）：
 *   第一层 整体 contentHash 比对 —— 绝大多数轮次无变化，O(1) 直接返回，省掉逐条计算
 *   第二层 仅在有变化时逐条比对，产出字段级差异
 *
 * 与现有服务的关键差异：
 *   竞品多数只报「新增条目」，无法发现「已有条目被修改」。
 *   新闻站更正错字、竞品改价、政策更新附件 —— 都不产生新增条目，只产生字段变化。
 */

import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * ★ 2026-10-19 修复与**同日回退**（实测发现引入 100% 假阳性）
 *
 * ── 第一次修复做了什么 ──
 * `updated` 是 RFC 4287 §4.2.15 里 publisher 声明「本次修改 significant」的
 * 时间戳，也就是 Atom 里**唯一为「条目被修改」设计的标准字段**。
 * 此前 parser 把它折进了 publishedAt（`published || updated`），
 * published 一旦存在，updated 就永远取不到 → 只改 updated 检不出变化。
 * 所以第一次修复把它加进了 TRACKED_FIELDS。**这个判断本身是对的。**
 *
 * ── 为什么必须回退（实测，非推测）──
 * 把它放进 TRACKED_FIELDS 意味着它进了**粗筛哈希**（见下方 Snapshot 构造）
 * 与**diff 载荷**。但「时间戳变了」**不携带任何内容信息**：
 *
 *   实测：Atom，仅 updated 变化、内容一字未改
 *     changed: true | reason: structural_diff | diff 字段: ["updated"]
 *     模拟一整天 4 次检查（内容全程未改）→ 告警 4 条，纯时间戳 4 条
 *     **假阳性率 100%**
 *
 *   根因：现实中大量 feed 每次构建都会刷新 entry 的 updated
 *   （CMS 重新生成、聚合器重排、缓存重建都会），而内容根本没变。
 *   Feedbin 早在 2014年就放弃了依赖 `<updated>`（"which was not always
 *   available"），改用「正文长度变化 > 50 字符」判定 —— 见下。
 *
 *   ⚠️ 我原先只防住了「updated 不存在」（空对空不产生 diff），
 *     没防住「updated 乱填」—— 存在但每次刷新。后者才是常见的。
 *
 * ── 为什么移出而不是「仅当内容也变才报」──
 * 若 updated 留在 TRACKED_FIELDS 里靠载荷层过滤，粗筛哈希仍会因它变化
 * 而放行 → 每次构建都要跑完整的逐字段 diff（O(n×字段数)），
 * **在零信息量上把成本付满**。移出后粗筛直接 hash_match，省掉全部开销。
 *
 * ── 那updated 就完全没用了吗 ──
 * 不是。**parser 仍然采集并落盘它**（见 feeds.js），保留两个价值：
 *   ① 将来若找到可靠的「如何区分真修改与重建噪声」判据，可直接启用
 *   ② 排障时能回答「发布方自己说它改过吗」—— 这是唯一的官方声明
 * 但它**不参与**判定，也**不进**对外载荷。
 *
 * 依据：Feedbin 的教训 + 实测 100% 假阳性。
 * 若将来要重新引入，**必须**先解决「时间戳刷新 ≠ 内容修改」的区分问题，
 * 且默认按「宁可漏报不可误报」取舍 —— 误报会让用户关掉通知然后不再信任。
 */
const TRACKED_FIELDS = ['title', 'contentText', 'link', 'publishedAt', 'author', 'category'];

/**
 * ⚠️ **辅助信号：不参与判定、不进载荷**（见上方回退理由）
 *
 * parser 会采集它、快照会存它，但：
 *   · 不在 TRACKED_FIELDS → 粗筛哈希不含它 → 变化不触发 changed
 *   · 不在 diff 载荷里→ 用户不会收到 "字段 updated 从 X 变成 Y"
 *
 * 保留它的唯一目的是**可观测性**：后台排障时可回答
 * 「发布方是否声明过它改过这条」，这是官方语义，排查时有用。
 *
 * 实测依据：仅 updated 变化、内容未改 → 假阳性率 100%。
 */
export const AUX_SIGNAL_FIELDS = Object.freeze(['updated']);

export class Snapshot {
  /**
   * @param {string} url
   * @param {object} parsed 解析结果 { format, title, items }
   * @param {string} fetchedAt
   */
  constructor(url, parsed, fetchedAt) {
    this.url = url;
    this.format = parsed.format;
    this.feedTitle = parsed.title;
    this.fetchedAt = fetchedAt;
    this.items = new Map();
    for (const it of parsed.items) this.items.set(it.id, it);

    /**
     * ★ P0-3 修复（2026-10-17）：粗筛哈希必须覆盖**全部** TRACKED_FIELDS。
     *
     * 原实现：
     *   parsed.items.map((i) => `${i.id}:${i.contentHash}`)
     * 而 `i.contentHash` 在 parser 里是 `sha256(cleanContent)` —— **只有正文**。
     *
     * 后果：改title / link / publishedAt / author / category 时，
     *   该条目的 contentHash 恒定 → 整份快照的 contentHash 恒定
     *   → `diffSnapshots` 第一层直接 `return { changed:false }`
     *   → **6 个TRACKED_FIELDS 里有 5 个永远检测不到**。
     *
     * 这直接击穿产品核心卖点：我们承诺「告诉你哪个字段变了」，
     *   而竞品只会说「这页变了」。但只要改动不涉及正文，
     *   **我们连「变了」都报不出来** —— 退化得比竞品还差。
     *
     * ⚠️ 为什么不在 parser 里改contentHash：
     *   parser 的 contentHash 是**对外契约**（落地页写明「正文只送哈希与长度，
     *   不回传全文」），改它会牵动 webhook 载荷与隐私承诺。
     *   而这里需要的只是「一个能代表整体是否变化的指纹」，
     *   在 Snapshot 层重算最安全、影响面最小。
     *
     * 成本：字符串拼接从「id+正文哈希」变成「id+全部 TRACKED_FIELDS 个字段」，
     *   但这仍是一次性 O(n) 且n 通常是几十到几百 —— 相比省掉的
     *   逐字段 diff（O(n×字段数)）依然是压倒性的划算。
     *
     * ★ 2026-10-19：新增 TRACKED_FIELDS 成员时**这里自动覆盖**，无需另改。
     *   粗筛哈希遍历的就是 TRACKED_FIELDS 本身（而非某份手写副本），
     *   所以「加了字段却忘了让粗筛感知」这类漏洞结构上不会发生。
     */
    this.contentHash = sha256(
      parsed.items
        .map((i) => `${i.id}:${TRACKED_FIELDS.map((f) => String(i[f] ?? '')).join('')}`)
        .sort()
        .join('|')
    );
  }

  static fromJSON(obj) {
    const s = Object.create(Snapshot.prototype);
    s.url = obj.url;
    s.format = obj.format;
    s.feedTitle = obj.feedTitle;
    s.fetchedAt = obj.fetchedAt;
    s.contentHash = obj.contentHash;
    s.items = new Map((obj.items ?? []).map((i) => [i.id, i]));
    return s;
  }

  toJSON() {
    return {
      url: this.url,
      format: this.format,
      feedTitle: this.feedTitle,
      fetchedAt: this.fetchedAt,
      contentHash: this.contentHash,
      items: [...this.items.values()],
    };
  }
}

/**
 * 比对新旧快照，产出结构化变更
 * @returns {{changed:boolean, changes:Array}}
 */
export function diffSnapshots(oldSnap, newSnap) {
  if (!oldSnap) {
    return {
      changed: true,
      reason: 'first_check',
      changes: [...newSnap.items.values()].map((i) => ({
        type: 'added', item_id: i.id, item: i, diff: [],
      })),
    };
  }

  // 第一层：哈希粗筛 —— 无变化则直接返回，省掉逐条计算
  if (oldSnap.contentHash === newSnap.contentHash) {
    return { changed: false, reason: 'hash_match', changes: [] };
  }

  // 第二层：逐条结构化比对
  const changes = [];

  for (const [id, newItem] of newSnap.items) {
    const oldItem = oldSnap.items.get(id);
    if (!oldItem) {
      changes.push({ type: 'added', item_id: id, item: newItem, diff: [] });
      continue;
    }
    const fieldDiff = diffItem(oldItem, newItem);
    if (fieldDiff.length > 0) {
      changes.push({ type: 'modified', item_id: id, item: newItem, diff: fieldDiff });
    }
  }

  for (const [id, oldItem] of oldSnap.items) {
    if (!newSnap.items.has(id)) {
      changes.push({ type: 'removed', item_id: id, item: oldItem, diff: [] });
    }
  }

  return { changed: changes.length > 0, reason: 'structural_diff', changes };
}

function diffItem(oldItem, newItem) {
  const out = [];
  for (const f of TRACKED_FIELDS) {
    /**
     * 存量基线兼容：**键不存在 ≠ 值为空串**。
     *
     * 旧快照的 item 上可能没有某个键（升级前没采集 / 之后才加的字段）。
     * 缺键意思是「当初根本没采集这个字段」，把它当成 '' 会报出一条
     * `'' → '2026-10-18T…'` 的假变更 —— 而内容一个字都没改。
     * 正确做法：没有基线可比就不声称它变了（下一轮基线即含该字段，自我修复）。
     *
     * 注：`updated` 已移出 TRACKED_FIELDS（见上方回退理由），但这条守卫
     * 保留 —— 它是通用的防御，任何未来新增字段都会自动获得这层保护。
     */
    if (!(f in oldItem)) continue;
    /**
     * ★ 方案乙（2026-10-19）：跳过「派生值」的 publishedAt。
     *
     * ⚠️⚠️ **必须读 `newItem`，绝不能读 `oldItem`** —— 这是本条最容易写错的地方：
     *   `oldItem` 来自 `Snapshot.fromJSON`，而**升级前的旧快照没有
     *   `publishedAtDerived` 这个键**（实测确认）。
     *     读 oldItem → 旧基线缺键 = falsy → **升级后首轮仍报假变更**，
     *       要等第二轮基线刷新才收敛 —— 而首轮就把所有存量监控点打爆了。
     *     读 newItem → 首轮即生效，对任意旧基线都成立。
     *   判定业务属性要用**当前解析出的新数据**，不能拿旧快照的「缺失」去猜。
     *
     * ⚠️ 符号也别写反：条件是 `publishedAtDerived === true` 才跳过。
     *   写成 `!publishedAtDerived` 会把**正常源**（published 真实存在、
     *   标记不存在）全部跳过 —— 实测验证过：符号一反，整个验证结论颠倒。
     *
     * 收益是「消除误标」，代价是「完全丢弃该源的修改时间变化信号」——
     * 这是「宁可漏报不可误报」的延续，不是「修好了误报」。
     */
    if (f === 'publishedAt' && newItem.publishedAtDerived === true) continue;
    const a = oldItem[f] ?? '';
    const b = newItem[f] ?? '';
    if (a === b) continue;
    if (f === 'contentText') {
      // 正文可能很长，只报是否变化与哈希，不全文回传
      out.push({
        field: f,
        changed: true,
        old_hash: sha256(String(a)),
        new_hash: sha256(String(b)),
        old_length: String(a).length,
        new_length: String(b).length,
      });
    } else {
      out.push({ field: f, changed: true, old: a, new: b });
    }
  }
  return out;
}

/**
 * 关键词过滤：仅保留命中关键词的变更
 */
export function filterByKeywords(changes, keywords) {
  if (!keywords || keywords.length === 0) return changes;
  const kws = keywords.map((k) => String(k).toLowerCase()).filter(Boolean);
  if (kws.length === 0) return changes;
  return changes.filter((c) => {
    const hay = `${c.item?.title ?? ''} ${c.item?.contentText ?? ''}`.toLowerCase();
    return kws.some((k) => hay.includes(k));
  });
}

/** 判断某条变更是否命中关键词（用于日志） */
export function matchesKeywords(change, keywords) {
  return filterByKeywords([change], keywords).length > 0;
}

export const __testing = { diffItem, TRACKED_FIELDS };