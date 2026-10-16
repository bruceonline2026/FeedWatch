#!/usr/bin/env node
/**
 * 静默失效自查 —— 提交前必跑
 *
 * ⚠️ 为什么要有这个脚本：
 *   10-12 我们就记录过「静默失效缺陷不会被任何『跑一下看看』的验证发现」。
 *   但 10-16 的 4 个新缺陷里仍有 3 个属同一家族 —— **教训没有自动生效**。
 *   光把教训写进文档等于没记录，必须变成**动作**。
 *
 * 这个脚本检查三个高发模式，每个都有真实的踩坑记录：
 *   ① 静默停调度     —— API 返 200，监控点实际已停（缺陷 8）
 *   ② 只声明不强制   —— 声明 A、执行 B（免费层频率偏差 24 倍）
 *   ③ 只覆盖部分方法 —— GET 有校验，PATCH/DELETE 没有（IDOR）
 *
 * 用法：
 *   node scripts/selfcheck-silent.js           # 全部检查
 *   node scripts/selfcheck-silent.js --verbose # 附详细信息
 *
 * 退出码：0 = 通过 / 1 = 有 FAIL
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

const src = readFileSync(join(ROOT, 'src/server.js'), 'utf8');
const service = readFileSync(join(ROOT, 'src/service.js'), 'utf8');
const e2e = readFileSync(join(ROOT, 'scripts/e2e.js'), 'utf8');

const results = [];
const check = (mode, name, ok, detail) => {
  results.push({ mode, name, ok, detail });
  const icon = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${icon} ${name}`);
  if (!ok && detail) console.log(`      \x1b[31m${detail}\x1b[0m`);
  else if (ok && VERBOSE && detail) console.log(`      \x1b[90m${detail}\x1b[0m`);
};

// ══════════════════════════════════════════════════════════════
// 模式 ① 静默停调度
// ══════════════════════════════════════════════════════════════
console.log('\n\x1b[1m模式 ① 静默停调度\x1b[0m \x1b[90m（API 返 200，实际已停）\x1b[0m');

{
  // ①-a  每个 service.stop() 调用点都必须有对应的行为断言
  const stopCalls = (src.match(/service\.stop\(/g) ?? []).length;
  check('停调度', 'service.stop() 调用点有对应的 PATCH 行为测试',
    e2e.includes('仅改名不误停') || e2e.includes('PATCH 部分更新不得静默停掉调度'),
    `stop() 调用 ${stopCalls} 处；e2e 需含「改名后调度仍存活」的行为断言`);

  // ①-b  PATCH 分支必须显式处理「未提供 status」的情况
  const hasPartialUpdateBranch = /else if \(updated\.intervalSeconds/.test(src);
  check('停调度', 'PATCH 区分「显式改 status」与「仅部分更新」',
    hasPartialUpdateBranch,
    '旧缺陷写法 `if (status===\'active\') schedule else stop` 会让「仅改名」停掉调度');

  // ①-c  熔断标记必须独立于 status（否则无法区分用户暂停与系统熔断）
  check('停调度', '熔断使用独立标记 trippedByCircuitBreaker',
    service.includes('trippedByCircuitBreaker') && !/status = 'paused';[\s\S]{0,80}tripped/.test(service),
    '熔断若借用 status 字段，会让手动 PATCH status=active 静默解除熔断');
}

// ══════════════════════════════════════════════════════════════
// 模式 ② 只声明不强制
// ══════════════════════════════════════════════════════════════
console.log('\n\x1b[1m模式 ② 只声明不强制\x1b[0m \x1b[90m（声明 A、执行 B）\x1b[0m');

{
  // ⚠️ 检查方法说明（这本身是一条教训）：
  //   第一版用 `src.includes('FREE_INTERVALS.includes(')` 判断，
  //   证伪时把校验体改成 `if (false)` —— **字符串还在，检查照样通过**。
  //   → 「检测代码里有没有某个字符串」是弱检查，会给假绿。
  //   → 改为检查**校验是否真的可达**：条件非恒假，且位于创建路径上。

  // ②-a  frequency 申报与强制共用同一数据源，且强制逻辑真的可达
  const usageBlock = src.slice(src.indexOf("/v1/usage"), src.indexOf("/v1/usage") + 600);
  const declaresFreq = usageBlock.includes('frequency');

  // 找频率校验点：必须匹配某个「非常量」的间隔
  const freqGuard = /if\s*\(\s*![A-Z_]+\.includes\(\s*Number\(body\.intervalSeconds\)\)\s*\)\s*\{[\s\S]{0,120}?return err\(/.test(src);

  check('只声明', 'frequency 申报与强制共用同一数据源，且强制逻辑真的可达',
    !declaresFreq || freqGuard,
    '① 把 if(...) 改成 if(false) 后仍能通过 → 说明检查只匹配了字符串，**这是假绿**\n      ② 正确：条件不能是恒假，且必须真的 return err');

  // ②-a2  额外确认：校验代码里没有 if (false) / if (0) 之类的占位
  const hasDeadGuard = /if\s*\(\s*(false|0|null)\s*\)\s*\{\s*\n\s*\/\/[^\n]*原实现|if\s*\(\s*false\s*\)\s*\{\s*\n\s*return err\(res, 422/.test(src);
  check('只声明', '没有被 `if (false)` 掩盖掉的校验占位',
    !hasDeadGuard,
    '检测到 if (false) 占位 —— 校验看着在、实际永不执行');

  // ②-b  MAX_MONITORS 必须在创建路径上真的被检查
  const declaresMonitors = usageBlock.includes('monitors: MAX_MONITORS');
  const enforcesMonitors = /owned >= MAX_MONITORS/.test(src);
  check('只声明', 'limit.monitors 在创建路径上真的被强制',
    !declaresMonitors || enforcesMonitors,
    '/v1/usage 申报了上限，但创建时不检查 = 配额形同虚设');

  // ②-c  签发限流必须真的调用了限流器（不是只定义常量）
  const declaresKeyLimit = src.includes('KEY_ISSUE_MAX');
  const enforcesKeyLimit = src.includes('rateLimit(`apikey:');
  check('只声明', 'Key 签发限流真的生效（非仅定义常量）',
    !declaresKeyLimit || enforcesKeyLimit,
    '定义了 KEY_ISSUE_MAX 但没调用 rateLimit() = 无限流');

  // ②-d  三处口径（页面/配置/接口）必须一致 —— 这是 E7 的教训
  const pageMonitors = [];
  for (const f of ['web/zh.html', 'web/en.html']) {
    try {
      const page = readFileSync(join(ROOT, f), 'utf8');
      const m = page.match(/(\d+)\s*个监控点/) ?? page.match(/(\d+)\s*monitors/);
      pageMonitors.push({ file: f, n: m ? Number(m[1]) : null });
    } catch { /* 页面不存在则跳过 */ }
  }

  const codeDefault = Number((src.match(/MAX_MONITORS \?\? (\d+)/) ?? [])[1] ?? NaN);
  const badPages = pageMonitors.filter(
    (p) => p.n !== null && !Number.isNaN(codeDefault) && p.n !== codeDefault,
  );
  check('只声明', '落地页声明的配额与代码默认值一致',
    badPages.length === 0,
    badPages.length
      ? `${badPages.map((p) => `${p.file} 写 ${p.n}`).join('、')}，代码默认 ${codeDefault} —— 必须相同`
      : `代码默认 ${codeDefault}，页面一致`);

  // ②-e  HTML 用了的 class 必须在 CSS 里有定义
  //
  // 实测教训（2026-10-17）：英文页用 class="code" 包pre，
  // 但 .code 这条规则**从未写进 CSS** —— pre 规则只设了浅色文字色，
  // 背景色在 .codeblock 上，于是浅字落在浅底上，**代码块整块看不见**。
  //
  // 这是「只声明不强制」的第四种形态：
  //   HTML 声明了样式来源 → CSS 里没有 → 静默失效，无报错、无日志
  // 而且**两版页面都受影响**（同一份 CSS），
  // 靠肉眼看截图才发现 —— 这正是它该被机械化检查的原因。
  const undefinedClasses = [];
  for (const f of ['web/zh.html', 'web/en.html']) {
    let page = '';
    try { page = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    const css = (page.match(/<style>([\s\S]*?)<\/style>/) ?? [])[1] ?? '';
    const used = new Set();
    for (const m of page.matchAll(/class="([^"]+)"/g)) {
      for (const c of m[1].split(/\s+/)) if (c) used.add(c);
    }
    const undef = [...used].filter(
      (c) => !new RegExp(`\\.${c.replace(/[-]/g, '\\-')}(?![a-zA-Z0-9_-])`).test(css),
    );
    if (undef.length) undefinedClasses.push(`${f}: ${undef.join(', ')}`);
  }
  check('只声明', 'HTML 用到的 class 在 CSS 中都有定义',
    undefinedClasses.length === 0,
    undefinedClasses.length
      ? `未定义 → ${undefinedClasses.join('；')} —— 该区块会静默失去样式`
      : `两版页面所有 class 均已定义`);

  // ②-f  pre 必须自带背景，不能依赖外层包装类
  //
  // 承接 ②-e：修复方式选的是「把背景加到 pre 上」而不是「补一条 .code 规则」，
  // 因为前者对任何未来新增的 pre 都成立，后者只救当前这一处。
  // 这条检查锁住这个选择 —— 防止后人把 pre 的背景删掉又变回隐形。
  let preHasBg = false;
  try {
    const page = readFileSync(join(ROOT, 'web/en.html'), 'utf8');
    const css = (page.match(/<style>([\s\S]*?)<\/style>/) ?? [])[1] ?? '';
    const rule = (css.match(/^pre\{([^}]*)\}/m) ?? [])[1] ?? '';
    preHasBg = /background\s*:/.test(rule);
  } catch { /* 跳过 */ }
  check('只声明', '代码块 pre 自带背景色（不依赖外层类）',
    preHasBg,
    'pre 无 background → 若外层包装类未定义，浅色代码文字落在浅色底上，整块不可读');
}

// ══════════════════════════════════════════════════════════════
// 模式 ③ 只覆盖部分方法
// ══════════════════════════════════════════════════════════════
console.log('\n\x1b[1m模式 ③ 只覆盖部分方法\x1b[0m \x1b[90m（GET 有校验、PATCH/DELETE 没有）\x1b[0m');

{
  // ③-a  归属校验必须在「按 id 的路由块入口」统一执行，
  //      或在每个方法分支内分别执行 —— 两者都算对。
  //      **错的是「只在某一个方法里校验，其余方法没有」。**
  //
  //      实测教训：IDOR 缺陷的形态是 ownedMonitor() 只被 GET 路径用到；
  //      修复后改成入口处统一校验（比逐方法调用更不容易漏）。
  const monStart = src.indexOf('const monMatch = path.match');
  const monEnd = src.indexOf('const checkMatch');
  const monBlock = monStart > 0 ? src.slice(monStart, monEnd > 0 ? monEnd : monStart + 3000) : '';

  const methodBranches = ['GET', 'PATCH', 'DELETE'].filter((m) =>
    monBlock.includes(`req.method === '${m}'`));

  // 形态 A：入口处统一校验（一次调用覆盖所有方法）
  const entryGuard =
    /if \(monMatch\) \{\s*\n\s*const found = ownedMonitor\(/.test(monBlock);
  // 形态 B：每个方法分支内各自校验
  const perMethodGuard = methodBranches.every((m) => {
    const at = monBlock.indexOf(`req.method === '${m}'`);
    if (at < 0) return true;
    return monBlock.slice(at, at + 500).includes('ownedMonitor');
  });

  check('跨租户', '按 id 操作的所有方法都有归属校验',
    monBlock.length === 0 || methodBranches.length === 0 || entryGuard || perMethodGuard,
    entryGuard
      ? `✓ 入口处统一校验（覆盖 ${methodBranches.join('/')}）`
      : (perMethodGuard
          ? `✓ 每个方法分支各自校验（${methodBranches.join('/')}）`
          : `归属校验不完整：仅有 ${monBlock.includes('ownedMonitor') ? '部分' : '零'}分支校验 —— IDOR`));

  // ③-1b  check 子路由（/check）也必须校验 —— 它在 monMatch 块之外，容易漏
  const checkStart = src.indexOf('const checkMatch');
  const checkBlock = checkStart > 0 ? src.slice(checkStart, checkStart + 600) : '';
  check('跨租户', '/check 子路由做了归属校验',
    checkBlock.length === 0 || checkBlock.includes('ownedMonitor'),
    'check 子路由在 monMatch 块之外，最容易漏掉归属校验');

  // ③-b  测试名声称的覆盖范围必须与实际断言的方法数一致
  const idorTest = e2e.slice(e2e.indexOf('跨租户 IDOR'), e2e.indexOf('跨租户 IDOR') + 1400);
  const claims = idorTest.match(/GET\/PATCH\/DELETE\/check/g);
  const asserts = ['stolen', 'patched', 'checked', 'deleted'].filter((v) => idorTest.includes(`const ${v}`));
  check('跨租户', 'IDOR 测试名声称的覆盖 = 实际断言的方法数',
    !claims || claims.length === 0 || asserts.length >= 3,
    `测试名声称 GET/PATCH/DELETE/check，但只断言了 ${asserts.length} 个方法 —— 不准确的测试名比没有测试更危险`);

  // ③-c  must 不能靠「约定」—— 签发权限必须显式检查
  check('跨租户', 'Key 签发显式检查引导密钥身份',
    /if \(!auth\.isBootstrap\)/.test(src),
    '只校验「有没有 Key」= 客户也能签发（权限提升）');
}

// ══════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════
const failed = results.filter((r) => !r.ok);
const warned = results.filter((r) => r.ok && VERBOSE);

console.log(`\n${'─'.repeat(64)}`);
if (failed.length === 0) {
  // 数字取自results.length，不写死 —— 写死过一次（写 9，实际 12）
  console.log(`\x1b[32m\x1b[1m✓ 全部通过\x1b[0m \x1b[90m（${results.length} 项检查）\x1b[0m`);
  console.log('\x1b[90m  注意：通过不等于「没漏洞」—— 只意味着这三类模式没被引入。\x1b[0m');
  console.log('\x1b[90m  新增功能时仍要做回退证伪：改回错误写法，看对应测试会不会红。\x1b[0m');
  process.exit(0);
} else {
  console.log(`\x1b[31m\x1b[1m✗ ${failed.length} 项未通过\x1b[0m \x1b[90m（共 ${results.length} 项）\x1b[0m`);
  console.log('\n每一条都对应一个真实踩过的坑，见 docs/复盘/回归测试要求点清单.md');
  process.exit(1);
}
