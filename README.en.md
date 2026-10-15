# FeedWatch

**RSS / Atom / JSON Feed change monitoring API + MCP Server**

Know when a feed *changes* — not just when it grows.

[Live site (Chinese)](https://api.tiici.com/) · [API docs](https://api.tiici.com/) · [MCP endpoint](https://api.tiici.com/mcp)

---

## English summary

FeedWatch monitors RSS, Atom, and JSON Feed URLs and pushes a webhook when they change.

**What makes it different:** most feed-monitoring tools only tell you *"a new item appeared."* They diff the **set of item IDs**, so any edit to an existing item is reported as *"no change."*

That misses exactly the cases people care about most:

- A competitor quietly raises a price — same product page, same item, different number
- A news org fixes a typo in yesterday's story — no new article, but the article changed
- A CVE entry gets its CVSS score or affected-versions list updated
- A policy document's wording is adjusted

FeedWatch compares **six fields per item** (`title`, `contentText`, `link`, `publishedAt`, `author`, `category`) and reports which field changed, with the old and new value:

```json
{
  "change_type": "modified",
  "title": "Starter",
  "diff": [{ "field": "title", "old": "Starter", "new": "Starter (New Pricing)" }]
}
```

Long content is reported as a hash plus a length delta rather than the full text.

---

## Quick start

### REST

```bash
curl -X POST https://api.tiici.com/v1/monitors \
  -H "x-api-key: $FEEDWATCH_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "Competitor pricing page",
    "url": "https://example.com/pricing.atom",
    "intervalSeconds": 21600
  }'
```

### MCP

Add to your MCP client config (Claude, Cursor, VS Code, Windsurf):

```json
{
  "mcpServers": {
    "feedwatch": {
      "url": "https://api.tiici.com/mcp",
      "headers": { "x-api-key": "<your-key>" }
    }
  }
}
```

Three tools: `create_monitor`, `list_monitors`, `check_feed`.

---

## API

Base URL: `https://api.tiici.com`

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Liveness check (no auth) |
| `/v1/monitors` | GET | List your monitors |
| `/v1/monitors` | POST | Create a monitor |
| `/v1/monitors/{id}` | GET / PATCH / DELETE | Read / update / delete |
| `/v1/monitors/{id}/check` | POST | Check once, immediately |
| `/v1/usage` | GET | Current plan and limits |
| `/mcp` | POST | MCP Streamable HTTP |

Authenticate with the `x-api-key` header (`Authorization: Bearer <key>` also works for MCP).

### Webhook payload

```json
{
  "event": "feed.changed",
  "monitor_id": "mon_xxx",
  "url": "https://example.com/pricing.atom",
  "format": "atom",
  "detected_at": "2026-10-15T08:48:29.900Z",
  "change_count": 1,
  "changes": [{
    "change_type": "modified",
    "title": "Starter",
    "diff": [{ "field": "title", "old": "Starter", "new": "Starter (New Pricing)" }]
  }]
}
```

**Verify the signature.** Webhooks carry `x-feedwatch-signature`, an HMAC-SHA256 over the request body. Without verification, anyone can forge a valid-looking push. If no secret is configured, we do not send the header — so clients can distinguish "not configured" from "verified".

---

## Features

| | |
|---|---|
| **Field-level diff** | Six tracked fields, reported with old / new values |
| **Three protocols** | RSS 2.0 (incl. RDF), Atom 1.0, JSON Feed 1.1 — auto-detected |
| **REST + MCP** | Same core logic, two entry points |
| **Signed webhooks** | HMAC-SHA256, 3 retries with 1s / 5s / 15s backoff |
| **Multi-channel** | Webhook, Slack, Discord |
| **Keyword filter** | Only alert on items matching your keywords |
| **SSRF hardening** | DNS pinning + per-hop revalidation; private ranges and cloud metadata addresses rejected. Webhook URLs go through the same guard. |

---

## Pricing

| Plan | Price | Monitors | Frequency |
|---|---|---|---|
| Free | $0 | 5 | every 6 hours |
| Starter | $9/mo | 25 | hourly |
| Pro | $29/mo | 100 | every 15 minutes |

Exceeding the free monitor limit returns `429` with an upgrade hint. **Existing monitors keep running** — the limit only blocks creating new ones. No auto-charge, no auto-downgrade.

---

## Engineering notes

```
Runtime       Node.js 22 ESM
Dependencies  fast-xml-parser (only runtime dep)
HTTP          node:http — no web framework
Deployment    Linux + Nginx + systemd, or Windows + IIS
Tests         89 offline assertions (5 suites), all passing
Size          ~2,100 lines across 7 modules
```

**Why zero framework dependencies:** it keeps deployment identical across Linux and Windows and reduces supply-chain surface.

### Tests

```bash
npm test          # 89 offline assertions
npm run test:live # 28 real-source assertions (requires outbound network)
```

### Security posture

- All outbound fetches go through `safeFetch` (SSRF guard), including webhook delivery
- Monitors are owned per API key; cross-tenant access returns `404` (not `403`, to avoid leaking existence)
- Node binds `127.0.0.1` only — never `0.0.0.0`. TLS and access logs terminate at the reverse proxy
- Feed bodies are capped at 10 MB; XML entity expansion is structurally bounded against billion-laughs

### Architecture

```
src/
├── server.js           HTTP entry (REST + MCP), binds 127.0.0.1
├── service.js          Scheduling, fetching, diffing, delivery + MemoryStore
├── parser/feeds.js     RSS 2.0 / Atom 1.0 / JSON Feed
├── diff/engine.js      Hash prefilter + field-level diff  ← core differentiator
├── notify/deliver.js   HMAC-signed webhook + retry
├── security/ssrf.js    SSRF guard, DNS pinning, outbound proxy
└── mcp/endpoint.js     MCP Streamable HTTP (3 tools)
```

---

## Known limitations

- **In-memory storage.** Monitors and snapshots live in memory and are lost on restart. This is a validation-stage limitation; persistent storage comes later.
- **No automatic renewal.** The payment link flow is manual — plan status is tracked outside the API during the validation stage.
- **Deep-namespace content is not diffed.** Content nested more than two levels deep (e.g. YouTube's `media:group/media:description`) is tracked by ID but its body is not diffed, by design: unbounded nesting depth is the billion-laughs vector. Item tracking and change detection are unaffected.

---

## Documentation

Chinese operational docs live in [`docs/`](./docs) — server procurement, deployment, payment setup, and post-mortems.

> ⚠️ When changing code, read [`docs/复盘/回归测试要求点清单.md`](./docs/复盘/回归测试要求点清单.md) first. It records which of the 89 tests actually assert what they claim to — **four of the "verified" labels in our own records turned out to be wrong.**

---

## License

MIT
