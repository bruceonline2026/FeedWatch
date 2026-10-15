/**
 * 调度器状态语义回归测试
 *
 * 背景：一次真实的安全审计发现 status 字段被同时用于两个不同语义：
 *   · 调度意图（active / paused）—— 决定是否排定时器
 *   · 健康状况（ok / error）    —— 最近一次检查的结果
 * 二者混用会导致：抓取失败时把 status 置为 'error'，而 tick 的守卫是
 * `if (m.status !== 'active') { stop(); return; }`，于是**一次网络抖动
 * 就让监控点永久静默失效**，且熔断阈值永远没机会生效。
 *
 * 这些断言锁死「三个状态必须分离」这一不变量，防止回归。
 */
import { MonitorService, MemoryStore } from '../src/service.js';

console.log('\n═══ 调度器状态语义回归 ═══\n');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { const d = await fn(); pass++; console.log(`  ✓ ${name}${d ? ` — ${d}` : ''}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

await t('★ 抓取失败不得把 status 改成 error（否则调度器自杀）', async () => {
  const store = new MemoryStore();
  const svc = new MonitorService(store);
  // 用真实不可达域名触发真实失败路径
  const m = store.createMonitor({ url: 'http://unreachable.invalid/feed.xml', intervalSeconds: 900 });

  svc.schedule(m, { firstDelayMs: 50 });
  await new Promise((r) => setTimeout(r, 700));

  assert(m.errorCount >= 1, `应记录失败次数，实际 ${m.errorCount}`);
  assert(m.status === 'active',
    `status 应仍为 active（调度意图），实际 ${m.status} —— 若为 error 说明调度器会被 tick 守卫杀掉`);
  // 先取快照再 stopAll，否则 stopAll 会清空 timers 导致下面的文案误报为 0
  const alive = svc.timers.size;
  const errCount = m.errorCount;
  svc.stopAll();
  assert(alive > 0,
    `定时器应仍存活，实际 size=${alive} —— 监控点已静默失效`);
  return `errorCount=${errCount}, status=${m.status}, timers=${alive}`;
});

await t('健康状况由 lastCheckOk 独立表达', async () => {
  const store = new MemoryStore();
  const svc = new MonitorService(store);
  const m = store.createMonitor({ url: 'http://unreachable.invalid/feed.xml', intervalSeconds: 900 });
  svc.schedule(m, { firstDelayMs: 50 });
  await new Promise((r) => setTimeout(r, 700));
  assert(m.lastCheckOk === false, `lastCheckOk 应为 false，实际 ${m.lastCheckOk}`);
  assert(m.status === 'active', 'status 不应被健康状态污染');
  svc.stopAll();
  return 'lastCheckOk=false 而 status=active，两者正交';
});

await t('熔断在达到阈值时生效（停止无限重试）', async () => {
  const store = new MemoryStore();
  const svc = new MonitorService(store, { errorThreshold: 3 });
  const m = store.createMonitor({ url: 'http://x.invalid/f.xml', intervalSeconds: 900 });

  svc._checkMonitor = async (mon) => {
    mon.errorCount = (mon.errorCount ?? 0) + 1;
    mon.lastCheckOk = false;
    return { error: 'boom' };
  };
  for (let i = 0; i < 4; i++) {
    svc.schedule(m, { firstDelayMs: 10 });
    await new Promise((r) => setTimeout(r, 60));
  }
  assert(m.trippedByCircuitBreaker === true, '应标记 trippedByCircuitBreaker');
  assert(svc.timers.size === 0, `熔断后应无定时器，实际 ${svc.timers.size}`);
  svc.stopAll();
  return `阈值 3 达到后熔断，重试已停止`;
});

await t('熔断可由用户显式恢复（PATCH status=active）', async () => {
  const store = new MemoryStore();
  const svc = new MonitorService(store, { errorThreshold: 2 });
  const m = store.createMonitor({ url: 'http://x.invalid/f.xml', intervalSeconds: 900 });
  svc._checkMonitor = async (mon) => {
    mon.errorCount = (mon.errorCount ?? 0) + 1;
    return { error: 'boom' };
  };
  svc.schedule(m, { firstDelayMs: 10 });
  await new Promise((r) => setTimeout(r, 150));

  store.updateMonitor(m.id, { status: 'active' });
  assert(m.errorCount === 0, `恢复时应清零 errorCount，实际 ${m.errorCount}`);
  assert(m.trippedByCircuitBreaker === false, '恢复时应解除熔断标记');

  svc.schedule(m, { firstDelayMs: 10 });
  assert(svc.timers.size > 0, '恢复后应能重新排程');
  svc.stopAll();
  return '用户可解除熔断，不会卡死';
});

await t('用户主动 pause 不应被健康检查改回 active', async () => {
  const store = new MemoryStore();
  const svc = new MonitorService(store);
  const m = store.createMonitor({ url: 'http://x.invalid/f.xml', intervalSeconds: 900 });
  store.updateMonitor(m.id, { status: 'paused' });

  // 手动跑一次检查（模拟 POST /check）
  svc._checkMonitor = async (mon) => { mon.lastCheckOk = true; mon.errorCount = 0; return { ok: true }; };
  await svc.checkMonitor(m);

  assert(m.status === 'paused',
    `用户暂停后不得被检查结果改回 active，实际 ${m.status}`);
  return '用户意图优先';
});

console.log(`\n═══ 结果：${pass} 项通过，${fail} 项失败 ═══\n`);
process.exit(fail === 0 ? 0 : 1);