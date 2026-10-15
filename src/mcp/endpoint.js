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
      'Fetch a feed immediately and return detected changes (added / modified / removed) with field-level diffs. Does not require a monitor to exist.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Feed URL to check once' },
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
        throw new Error(`监控点数量已达上限（${max}）`);
      }
      const m = await ctx.store.createMonitor({
        url: args.url,
        name: args.name,
        intervalSeconds: args.intervalSeconds ?? 21600,
        keywords: args.keywords ?? [],
        // 归属：此前 MCP 创建的监控点 apiKeyId 恒为 null，
        // 导致 REST 列表过滤 `|| !m.apiKeyId` 把它们暴露给所有持 key 者
        apiKeyId: ctx.apiKeyId ?? null,
      });
      return text({ ok: true, monitor: publicView(m) });
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
      const result = await ctx.checkOnce(args.url);
      const changes = result.changes.slice(0, LIMIT);
      return text({
        url: result.url,
        format: result.format,
        changed: result.changed,
        reason: result.reason,
        change_count: result.changes.length,
        returned: changes.length,
        truncated: result.changes.length > LIMIT,
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