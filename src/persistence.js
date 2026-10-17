/**
 * 持久化存储：监控点 / 快照基线 / API Key
 *
 * ══════════════════════════════════════════════════════════════
 * 为什么现在做这个（2026-10-17，徐总指出）
 * ══════════════════════════════════════════════════════════════
 * 之前所有状态都在内存里，`systemctl restart feedwatch` 之后：
 *
 *   ·客户的监控点全部消失 —— 他不知道，告警静默停止
 *   · 快照基线丢失 → 重启后首次检查把所有条目当「新增」，**全是假告警**
 *   · API Key 失效 → 客户必须重新配置
 *
 * ⚠️ 这不是「客户少就可以省的功能」。**监控服务的客户数据只在内存里，
 *    任何一次升级、补丁、重启都会清空** —— 那产品本身就不成立。
 *
 * ── 为什么用 JSON 文件而不是 SQLite ──
 *   生产 Node v22.23.3 / 本地 v22.12.0，`node:sqlite` 在这个区间仍是
 *   实验性模块（需 --experimental-sqlite 标志），**不能作为依赖**。
 *   而仓库当前是**零运行时依赖**（只有 fast-xml-parser）。
 *   引入 better-sqlite3 = 引入原生编译依赖，与项目现状不符。
 *
 *   监控点量级判断：免费层每人 5 个，验证期 0-5 客户 → 上限几百个。
 *   **几百条记录 × 每次变更全量重写**，完全在能力范围内，且不需要数据库。
 *   真正到「写入成为瓶颈」时（> 数千监控点或写入 > 1 次/秒）再换 SQLite。
 *
 * ── 写入策略：变更即写，不是定时刷 ──
 *   定时刷存在「崩溃即丢最近 N 秒」的窗口，而 N 秒的监控点丢失
 *   正好是最影响客户的时刻（刚建完就重启）。所以每次变更同步写。
 *
 * ── 崩溃安全 ──
 *   先写临时文件 → fsync → rename。rename 在同一文件系统上是原子的，
 *   所以不存在「写到一半的 JSON 被读出来」这种状态。
 */

import {
  readFileSync, writeFileSync, renameSync, existsSync, mkdirSync,
  openSync, fsyncSync, closeSync, chmodSync, unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** 当前 schema 版本 —— 将来结构变了靠它做迁移 */
const SCHEMA_VERSION = 1;

/**
 * ⚠️ 落盘文件权限必须是 600（仅属主可读写）。
 *
 * 快照里明文存着 feed 条目标题与正文 —— 那是我们客户的数据。
 * 默认的 644 意味着**同机器上任何用户都能读到**（实测 `sudo -u nobody` 能读出来），
 * 在有多个服务共用的机器上就是泄露。
 *
 * 同理目录要 700。这两行不是「加固建议」，是**必须项**。
 */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export class PersistentStore {
  /**
   * @param {string} file 数据文件路径
   * @param {object} opts
   * @param {boolean} [opts.enabled] 设为 false 可完全退回内存模式（测试用）
   */
  constructor(file, { enabled = true } = {}) {
    this.file = file;
    this.enabled = enabled;
    /** 写盘节流：同一 tick 内多次变更只写一次 */
    this._dirty = false;
    this._writeScheduled = false;
  }

  /** 读取全部持久状态；文件不存在或损坏时返回 null（由调用方决定是否报错） */
  load() {
    if (!this.enabled) return null;
    try {
      if (!existsSync(this.file)) return null;
      const raw = readFileSync(this.file, 'utf8');
      if (!raw.trim()) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return null;
      return data;
    } catch (e) {
      // ⚠️ 数据损坏时**不能静默当空** —— 那等于再丢一次客户数据。
      //    这里把文件重命名保留现场，由调用方决定是否拒绝启动。
      try {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        renameSync(this.file, backup);
        // ⚠️ 备份文件同样含 feed 标题与正文，权限不能比原文件松
        try { chmodSync(backup, FILE_MODE); } catch { /* 见 save() 内的同类说明 */ }
        console.error(
          `[feedwatch] 持久化文件损坏，已另存为 ${backup}，将以空数据启动：${e.message}`,
        );
      } catch { /* 另存也失败则只能放弃 */ }
      return null;
    }
  }

  /**
   * 写入全部状态（原子）。
   * @param {{apikeys: object[], monitors: object[], snapshots: object[]}} data
   */
  save(data) {
    if (!this.enabled) return false;
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      // ⚠️ 目录权限也要收紧 —— 已存在的目录（如被手工建过）不会自动跟着变
      try { chmodSync(dir, DIR_MODE); } catch { /* 无权限时由部署流程保证 */ }

      const payload = JSON.stringify({ version: SCHEMA_VERSION, saved_at: new Date().toISOString(), ...data });
      // 临时文件 + rename = 原子替换，崩溃时不会留下半个 JSON
      const tmp = `${this.file}.tmp`;
      // ⚠️ writeFileSync 的 mode 参数**只在文件被创建时生效**。
      //   已存在的文件会保留旧权限 —— 所以下面 rename 之后还要再 chmod 一次，
      //   否则「首次创建时是 600、后来变 644」这种漂移无法察觉。
      writeFileSync(tmp, payload, { encoding: 'utf8', mode: FILE_MODE });
      try {
        const fd = openSync(tmp, 'r');
        fsyncSync(fd);
        closeSync(fd);
      } catch { /* 某些文件系统不支持 fsync，rename 仍是原子的 */ }
      renameSync(tmp, this.file);
      // rename 会保留源文件的权限位（tmp 已是 600），但为防既有文件权限不对，
      // 这里显式再设一次 —— 幂等，且是唯一能修正历史遗留权限的地方
      try { chmodSync(this.file, FILE_MODE); } catch { /* 见上 */ }
      return true;
    } catch (e) {
      // ⚠️ 写盘失败**必须让上层知道** —— 静默失败等于假装存了，
      //    下一次重启就会丢，而没人知道。
      console.error(`[feedwatch] 持久化写入失败（重启将丢失变更）：${e.message}`);
      return false;
    }
  }

  /** 标记有变更，请求一次写入（合并同一 tick 内的多次标记） */
  markDirty(scheduler) {
    if (!this.enabled) return;
    this._dirty = true;
    if (this._writeScheduled) return;
    this._writeScheduled = true;
    // setImmediate = 本次事件循环结束后写，既合并了同 tick 的多次变更，
    // 又不像 setTimeout 那样引入额外延迟
    setImmediate(() => {
      this._writeScheduled = false;
      if (!this._dirty) return;
      this._dirty = false;
      scheduler?.();
    });
  }

  /** 同步刷盘（进程退出前调用） */
  flush(scheduler) {
    if (!this.enabled) return true;
    this._dirty = false;
    this._writeScheduled = false;
    return scheduler ? this.save(scheduler()) : true;
  }
}

export { SCHEMA_VERSION };
