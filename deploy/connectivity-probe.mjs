/**
 * 出网连通性探针 —— 必须在目标服务器上运行
 *
 * 为什么不用 curl 直接测？
 *   curl 通 ≠ Node 通。代理配置、证书链、DNS 解析器（node:dns vs 系统）
 *   都可能让 Node 走不同的路径。本探针调用**项目自身的 safeFetch**，
 *   测的就是生产环境真正会执行的代码路径。
 *
 * 运行：node deploy/connectivity-probe.mjs
 * 退出码：0=境外可达  1=境外不可达（上线阻塞）
 */

import { safeFetch } from '../src/security/ssrf.js';

const DOMESTIC = [
  ['人民网 RSS',   'http://www.people.com.cn/rss/politics.xml'],
  ['中新网 RSS',   'http://www.chinanews.com.cn/rss/scroll-news.xml'],
  ['少数派 RSS',   'https://sspai.com/feed'],
];

const OVERSEAS = [
  ['GitHub Releases Atom', 'https://github.com/torvalds/linux/releases.atom'],
  ['Cloudflare Blog',      'https://blog.cloudflare.com/rss/'],
  ['Hacker News RSS',      'https://hnrss.org/frontpage'],
];

async function probe(label, url) {
  const t = Date.now();
  try {
    const r = await safeFetch(url, { timeoutMs: 12_000 });
    const ms = Date.now() - t;
    if (r.status === 200 && r.body.length > 0) {
      console.log(`    ✓ ${label.padEnd(24)} HTTP ${r.status}  ${String(ms).padStart(6)}ms  ${(r.body.length / 1024).toFixed(0)}KB`);
      return true;
    }
    console.log(`    ✗ ${label.padEnd(24)} HTTP ${r.status}  ${ms}ms`);
    return false;
  } catch (e) {
    const ms = Date.now() - t;
    console.log(`    ✗ ${label.padEnd(24)} ${String(e.code ?? e.message).slice(0, 28).padEnd(28)}  ${ms}ms`);
    return false;
  }
}

console.log('    境外源（决定产品核心价值是否成立）：');
const overseasResults = [];
for (const [label, url] of OVERSEAS) overseasResults.push(await probe(label, url));

console.log('');
console.log('    国内源：');
const domesticResults = [];
for (const [label, url] of DOMESTIC) domesticResults.push(await probe(label, url));

const overseasOk = overseasResults.filter(Boolean).length;
const domesticOk = domesticResults.filter(Boolean).length;

console.log('');
console.log(`    汇总：境外 ${overseasOk}/${OVERSEAS.length} 可达，国内 ${domesticOk}/${DOMESTIC.length} 可达`);

if (overseasOk === 0) {
  console.log('');
  console.log('    ★ 判定：境外源全部不可达 —— GitHub release / 国外新闻 RSS 监控不可用。');
  console.log('      这是上线阻塞项，详见 deploy/connectivity-check.cmd 输出的三个方案。');
} else if (overseasOk < OVERSEAS.length) {
  console.log('');
  console.log(`    ★ 判定：境外源部分可达（${overseasOk}/${OVERSEAS.length}），可能有白名单或不稳定因素。`);
  console.log('      可上线，但需在 README 中说明部分境外源可能抓取失败。');
} else {
  console.log('');
  console.log('    ★ 判定：境外源全部可达 —— 出网无限制，可以正常上线。');
}

process.exit(overseasOk === 0 ? 1 : 0);