/**
 * MCP Streamable HTTP 端点
 *
 * 面向 Claude / ChatGPT / Codex 等客户端暴露三个工具：
 *   create_monitor — 创建监控点
 *   list_monitors — 列出监控点
 *   check_feed    — 立即检查一次并返回变更（Agent 最常用的入口）
 *
 * 说明：MVP 阶段用 JSON-RPC over HTTP 实现工具调用，
 * 数据层通过传入的 store 抽象，测试时用内存实现。
 */

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'create_monitor',
    description:
      'Create a change monitor on an RSS, Atom, or JSON Feed URL. The monitor will report new items and—unlike most tools—edits to existing items, with field-level diffs.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The RSS/Atom/JSON Feed URL to monitor' },
        name: { type: 'string', description: 'Optional human-readable label' },
        intervalSeconds: {
          type: 'integer',
          enum: [21600, 3600, 900],
          description: 'Check frequency. 21600=6h, 3600=1h, 900=15min. Default 21600.',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only alert when title or content matches one of these keywords',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'list_monitors',
    description: 'List all change monitors for this account with their status and next check time.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_feed',
    description:
      'Fetch a feed immediately and return detected changes (added / modified / removed) with field-level diffs. Does not require a monitor to exist. '
      + 'Stateful: the first call for a given URL establishes a baseline and reports every item as "added"; '
      + 'later calls on the same URL compare against that baseline and report "modified" with per-field old/new values. '
      + 'Snapshots are scoped to your API key and kept in memory only (lost on service restart). '
      + 'Pass resetBaseline:true to discard the stored baseline and start over.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Feed URL to check' },
        resetBaseline: {
          type: 'boolean',
          description: 'Discard the stored baseline for this URL so the next call starts fresh',
        },
      },
      required: ['url'],
    },
  },
];

/**
 * 处理一个 JSON-RPC 请求。
 *
 * ⚠️ 必须返回 Promise —— tools/call 需要 await store 与网络，
 *    若为同步返回，Promise 会被 JSON.stringify 序列化成 {}，
 *    导致工具调用静默失效（本项目实际踩过这个坑）。
 */
export function handleMcpRequest(body, ctx) {
  const { method, id, params } = body ?? {};
  const respond = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return Promise.resolve(respond({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'feedwatch', version: '0.1.0' },
      }));

    case 'notifications/initialized':
      return Promise.resolve({ jsonrpc: '2.0' }); // 通知，无需结果

    case 'tools/list':
      return Promise.resolve(respond({ tools: TOOLS }));

    case 'tools/call':
      return callTool(params, ctx)
        .then((content) => respond({ content }))
        .catch((err) => fail(-32000, err.message));

    case 'ping':
      return Promise.resolve(respond({}));

    default:
      return Promise.resolve(fail(-32601, `Method not found: ${method}`));
  }
}

async function callTool(params, ctx) {
  const { name, arguments: args = {} } = params ?? {};

  // ⚠️ 修复记录（响应结构多包了一层）：
  //   原 `text()` 返回 { content: [...] }，而调用处又写成 respond({ content })，
  //   最终得到 result.content.content[0].text。
  //   MCP 协议规定 result.content 直接是内容数组，标准客户端读 result.content[0]
  //   会拿到 undefined —— 工具调用静默失败（与项目里踩过的另一个 async 坑同类）。
  const text = (v) => [{
    type: 'text',
    text: typeof v === 'string' ? v : JSON.stringify(v, null, 2),
  }];

  switch (name) {
    case 'create_monitor': {
      // 配额：此前 MCP 路径完全无鉴权且无上限，实测匿名 500 次创建仅耗 162ms
      const max = ctx.maxMonitors ?? Infinity;
      const owned = ctx.apiKeyId
        ? ctx.store.countByOwner?.(ctx.apiKeyId)
        : ctx.store.listMonitors().length;
      if (owned >= max) {
        // ⚠️ **配额必须在预检之前**（2026-10-17 修正）：
        //   预检要出网。若顺序反过来，配额已满的用户每次重试都会先抓一次
        //   上游再被拒 —— 白烧出网流量，也给上游造成无意义的压力。
        //   REST 路径（src/server.js）同样是「配额先、预检后」。
        throw new Error(`监控点数量已达上限（${max}）`);
      }

      // ★ P0-1 修复（2026-10-17）：建点当场验证 URL。
      //   原实现直接建点返回 ok:true，Agent 于是报告「已为你创建监控」，
      //   但若 URL 不是 feed（例：普通网页），失败要等下一次调度才暴露 ——
      //   实测 `https://www.tiici.com/` 就是建点成功、数小时后才报
      //   「不是有效的 RSS/RDF 结构」。Agent 会把这个错误转述成「监控已建好」，
      //   **比 REST 路径更容易误导用户**。
      // 现在：抓一次验证，不是 feed 就当场报错并给出下一步建议。
      let probe = null;
      if (typeof ctx.checkOnce === 'function') {
        try {
          probe = await ctx.checkOnce(args.url, null);
        } catch (e) {
          throw new Error(
            `Cannot monitor that URL: ${e.message}. `
            + 'If it is a normal web page, use its RSS/Atom address instead '
            + '(try /feed, /rss.xml or /atom.xml).',
          );
        }
      }

      const m = await ctx.store.createMonitor({
        url: args.url,
        name: args.name,
        intervalSeconds: args.intervalSeconds ?? 21600,
        keywords: args.keywords ?? [],
        // 归属：此前 MCP 创建的监控点 apiKeyId恒为 null，
        // 导致 REST 列表过滤 `|| !m.apiKeyId` 把它们暴露给所有持 key 者
        apiKeyId: ctx.apiKeyId ?? null,
      });

      // 预检结果直接当基线，省掉一次重复抓取，也让首次调度只报真实差异
      if (probe?.snapshot) {
        try { ctx.store.saveSnapshot(m.id, probe.snapshot); } catch { /* 存储异常不该让建点失败 */ }
      }

      // ★ 第三个 bug（2026-10-17 修复时发现）：
      //   MCP 建点路径**从不调用 service.schedule()** —— 而REST 的
      //   POST /v1/monitors 会调。于是经MCP 创建的监控点：
      //     建得出来、列得出来、但**永远不会被定时检查**，
      //     用户以为在监控，实际什么都没发生。
      //   这正是今天修的 P0-1 的另一面：预检让「建点成功」看起来更可信了，
      //   但不调度的话，预检那次抓取就是唯一一次抓取。
      //
      //   ctx.schedule 由 server.js 注入（endpoint 层不应直接依赖 service 单例）。
      if (typeof ctx.schedule === 'function') {
        try {
          ctx.schedule(m, { firstDelayMs: (m.intervalSeconds ?? 21600) * 1000 });
        } catch { /* 调度失败不该让建点失败 —— 监控点仍在列表里，可 PATCH 恢复 */ }
      }

      return text({
        ok: true,
        monitor: publicView(m),
        // 让 Agent 能立刻告诉用户「验证通过、格式是什么、有几条」
        verified: probe
          ? {
            ok: true,
            format: probe.format,
            feed_title: probe.feedTitle,
            item_count: probe.changes.length,
            hint: 'Verified the URL is a readable feed; this result is now the baseline.',
          }
          : { ok: false, hint: 'server build does not support pre-flight verification' },
      });
    }

    case 'list_monitors': {
      const all = await ctx.store.listMonitors();
      // 归属过滤：只列出本 key 的监控点
      const list = ctx.apiKeyId ? all.filter((m) => m.apiKeyId === ctx.apiKeyId) : all;
      return text({ count: list.length, monitors: list.map(publicView) });
    }

    case 'check_feed': {
      // 限制单次返回的变更条数：上游 feed 可达 10MB / 数万条，
      // 匿名（或低权）调用会把整份快照序列化进响应，实测单请求即可产生 MB 级响应
      const LIMIT = 50;

      // ★ P0-2 修复（2026-10-17）：原来这里调 `ctx.checkOnce(args.url)`，
      //   而 server.js 绑的是 `(u) => checkOnce(u, store, null)` —— prevSnapshot
      //   **硬编码 null**，于是每次都是 first_check、全部报 added，
      //   **永远报不出 modified** —— 我们卖的核心能力在这个工具上等于没有。
      //
      //   现在改为：按 (apiKeyId, url) 取上一份快照做对比，再存回新的。
      //   ctx 必须提供 getEphemeralSnapshot / saveEphemeralSnapshot /
      //   clearEphemeralSnapshot 与 apiKeyId；缺失则退回旧行为（不崩，但无状态）。
      const hasStore = typeof ctx.getEphemeralSnapshot === 'function'
        && typeof ctx.saveEphemeralSnapshot === 'function';
      const scope = ctx.apiKeyId ?? 'anonymous';

      if (args.resetBaseline === true && typeof ctx.clearEphemeralSnapshot === 'function') {
        ctx.clearEphemeralSnapshot(scope, args.url);
      }

      const prev = hasStore ? ctx.getEphemeralSnapshot(scope, args.url) : null;
      const result = await ctx.checkOnce(args.url, prev);
      if (hasStore) ctx.saveEphemeralSnapshot(scope, args.url, result.snapshot);

      const changes = result.changes.slice(0, LIMIT);
      return text({
        url: result.url,
        format: result.format,
        changed: result.changed,
        reason: result.reason,
        change_count: result.changes.length,
        returned: changes.length,
        truncated: result.changes.length > LIMIT,
        // 告诉调用方基线是否可用 —— 否则 Agent 无法判断「这次没变化」是真没变还是丢了基线
        baseline: hasStore
          ? { stored: true, scoped_to_your_key: true, memory_only: true }
          : { stored: false, hint: 'this server build has no snapshot memory; every call reports first_check' },
        changes: changes.map((c) => ({
          change_type: c.type,
          item_id: c.item_id,
          title: c.item?.title ?? '',
          link: c.item?.link ?? '',
          diff: c.diff,
        })),
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function publicView(m) {
  return {
    id: m.id,
    url: m.url,
    name: m.name,
    interval_seconds: m.intervalSeconds,
    keywords: m.keywords,
    status: m.status,
    last_checked_at: m.lastCheckedAt ?? null,
    last_change_at: m.lastChangeAt ?? null,
    next_check_at: m.nextCheckAt ?? null,
    error_count: m.errorCount ?? 0,
    last_check_ok: m.lastCheckOk ?? null,
    tripped_by_circuit_breaker: m.trippedByCircuitBreaker ?? false,
  };
}

/** 协议声明文件 —— MCP 注册表与客户端读取用 */
export function serverManifest(publicUrl, repoUrl) {
  return {
    name: 'io.github.your-org/feedwatch',
    description: 'Monitor RSS/Atom/JSON feeds and get webhook alerts on new items AND edits to existing ones',
    version: '0.1.0',
    repository: { url: repoUrl, source: 'github' },
    remotes: [{ type: 'streamable-http', url: publicUrl }],
  };
}

export { TOOLS };