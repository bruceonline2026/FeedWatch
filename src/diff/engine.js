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

const TRACKED_FIELDS = ['title', 'contentText', 'link', 'publishedAt', 'author', 'category'];

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
    this.contentHash = sha256(
      parsed.items.map((i) => `${i.id}:${i.contentHash}`).sort().join('|')
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