# domain-drop-watcher

> Watch domains. Catch drops. Beat the typosquatters.

[![CI](https://github.com/oitray/domain-drop-watcher/actions/workflows/ci.yml/badge.svg)](https://github.com/oitray/domain-drop-watcher/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Runs on Cloudflare Workers (free tier)](https://img.shields.io/badge/Runs%20on-Cloudflare%20Workers%20free%20tier-orange?logo=cloudflare)](https://developers.cloudflare.com/workers/)

## Why this exists

A peer's client was repeatedly typosquatted by the same attacker. The registrar
would take the domain down on an abuse complaint — then release it back into the
pool. The attacker grabbed it again within minutes, sometimes at a different
registrar.

Commercial drop-catchers (DropCatch, SnapNames, Park.io, Dynadot Backorder)
charge per domain and target domainers, not defenders. No FOSS, self-hostable
option existed for an MSP to run on a client's behalf — for free, without
per-domain fees, and without handing watch-list data to a third party.

This tool fills that gap. It runs entirely inside Cloudflare's free tier.

## How it works

```
+--------------------+     Cron (* * * * *)       +-------------------+
|  Cloudflare Worker |---- per-minute scheduler ---|  RDAP lookups     |
|  (src/worker.ts)   |     IANA bootstrap +        |  authoritative    |
|                    |     authoritative RDAP       |  registry servers |
+--------------------+                            +-------------------+
        |                                                   |
        | D1 (state) + KV (events cache)                    |
        v                                                   v
+--------------------+     on status change       +-------------------+
|  Admin HTTP routes |--------------------------->|  Alert channels   |
|  Bearer-auth       |     dedupe + fan out       |  - Resend (email) |
|  GET/POST/DELETE   |                            |  - Teams webhook  |
|  /domains, /chans  |                            |  - Slack webhook  |
+--------------------+                            |  - Discord webhook|
        ^                                         |  - Generic POST   |
        |                                         +-------------------+
+--------------------+
|  Admin Dashboard   |
|  public/index.html |
|  (vanilla JS SPA)  |
+--------------------+
```

Each cron run pulls the next ≤45 due domains from D1, checks their RDAP status
in parallel, applies a two-run confirmation gate to prevent false positives, and
fans out alerts to all configured channels. State is persisted in D1 (SQLite);
Workers KV is used only for a non-critical event ring buffer and the IANA
bootstrap cache.

## Deploy

### Option 1 — Deploy button (one-click fork + deploy)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/oitray/domain-drop-watcher)

### Option 2 — Interactive setup wizard (recommended for MSPs)

```
git clone https://github.com/oitray/domain-drop-watcher
cd domain-drop-watcher
npm install
npm run setup
```

`npm run setup` launches an interactive wizard that guides you through:

1. Cloudflare auth (uses your existing `wrangler login` session or a scoped API
   token you export in-shell — the token is **never** written to any file or
   stored in the Worker runtime)
2. D1 database + KV namespace provisioning (idempotent — safe to re-run)
3. `schema.sql` bootstrap
4. Admin token generation (32-byte random, stored via `wrangler secret put`)
5. Email alerts via Resend (optional — skip and use webhooks only)
6. Webhook host allowlist (Teams, Slack, Discord covered by default)
7. `wrangler deploy` + smoke test against `/health`

Re-run with flags to update a single piece of config later:

```
./scripts/setup.sh --email           # add or rotate Resend credentials
./scripts/setup.sh --webhooks        # update webhook allowlist
./scripts/setup.sh --rotate-admin    # generate a new ADMIN_TOKEN
```

### Option 3 — Manual

```
wrangler d1 create domain-drop-watcher-db
wrangler kv:namespace create EVENTS
wrangler kv:namespace create BOOTSTRAP
# patch the returned IDs into wrangler.toml, then:
wrangler d1 execute domain-drop-watcher-db --file=schema.sql
printf '%s' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" \
  | wrangler secret put ADMIN_TOKEN
wrangler deploy
```

## Free-tier budget

The worker runs a single `* * * * *` cron trigger. Each invocation checks ≤45
domains (hard `LIMIT 45` to stay inside the 50-subrequest free-tier ceiling,
leaving 5 subrequests for alerts and bootstrap fetches).

Per-domain cadence controls how often each domain is checked. The peak concurrent
lookups per minute is always ≤45 regardless of watchlist size.

| Cadence | Max domains at 45/min cap | Daily checks | Daily D1 writes |
|---------|--------------------------|--------------|-----------------|
| 1 min   | 45                        | 64,800       | ~68k            |
| 5 min   | 225                       | 64,800       | ~68k            |
| 15 min  | 675                       | 64,800       | ~68k            |
| 60 min  | 2,700                     | 64,800       | ~68k            |

Daily D1 writes stay constant because each invocation checks exactly 45 domains
regardless of cadence — cadence controls *which* domains are checked each minute,
not how many per run. D1 free tier allows 100k writes/day; this workload lands
around 68k.

The live `/budget` endpoint in your deployment shows exact numbers for your
watchlist. The dashboard's cadence slider calls `/budget?simulate=...` to preview
changes before committing.

## Operator surface

<!-- TODO: dashboard screenshot -->

The admin dashboard (`public/index.html`) is a vanilla-JS single-page app served
by the Worker itself. No build step. Access it at your Worker URL.

- **Budget gauge** — live peak/min, daily checks, KV writes, free-tier headroom
- **Global pause/resume** — stop all checks with one click
- **Domains table** — per-domain status, cadence (inline-edit), paused toggle, linked channels, per-row actions (check-now, event history, delete)
- **Bulk add** — paste one FQDN per line, preview budget impact before committing
- **Channels tab** — add/edit/disable email and webhook targets; test-send button; last delivery result
- **Events tab** — rolling log of status transitions and alert sends
- **Settings tab** — default cadence, webhook allowlist display, admin token rotation guidance

The same surface is available via `curl` + documented endpoints. A small
`scripts/cli.sh` wrapper provides `dropwatch add <fqdn>`, `dropwatch list`,
`dropwatch pause <fqdn>`, and `dropwatch budget` shortcuts reading `ADMIN_TOKEN`
and `WORKER_URL` from env.

## Alert channels

| Channel | How | Notes |
|---------|-----|-------|
| Email | Resend API | Requires verified sending domain (SPF + DKIM). Free tier: 3k emails/mo, 100/day. |
| Microsoft Teams | Incoming webhook | Auto-detected via `*.webhook.office.com` host; formatted as MessageCard with `#e42e1b` accent. |
| Slack | Incoming webhook | Auto-detected via `hooks.slack.com`; formatted as Block Kit blocks. |
| Discord | Incoming webhook | Auto-detected via `discord.com/api/webhooks`; formatted as embed with `#e42e1b` color. |
| Generic webhook | POST JSON | Any HTTPS endpoint on your allowlist. Payload: `{fqdn, oldStatus, newStatus, detectedAt, rdap}`. |

All channels fan out in parallel via `Promise.allSettled` — one failed delivery
does not block the others.

## Security notes

**Admin auth.** All `/domains`, `/channels`, `/budget`, `/events`, and `/check/*`
routes require `Authorization: Bearer <ADMIN_TOKEN>`. Comparison uses
`crypto.timingSafeEqual` to prevent timing attacks. `/health` is unauthenticated.

**Dashboard CSP.** The HTML is served with
`default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'`.
`unsafe-inline` is intentional — the dashboard is a single self-contained HTML
file with no build step. Nonce-based CSP is a planned enhancement (requires a
per-request build step to inject nonces).

**Webhook SSRF hardening.** Cloudflare Workers resolve outbound `fetch()`
hostnames at the edge — Worker code does not see the resolved IP, so a
hostname-blocklist approach is not implementable from inside the Worker. The
tool uses an **allowlist-first** policy:

- Literal-IP hostnames are rejected unconditionally.
- Non-HTTPS URLs are rejected.
- Hostnames are canonicalized before matching: lowercased, IDNA to punycode,
  trailing dot stripped. Prevents unicode-homograph and normalization-bypass
  attacks.
- The operator-configured `WEBHOOK_HOST_ALLOWLIST` (comma-separated glob
  patterns) gates all webhook targets. Default:
  `*.webhook.office.com,hooks.slack.com,discord.com,discordapp.com`.
- Generic webhooks to custom endpoints require the operator to explicitly add
  the hostname — intentional friction.

**Subdomain wildcard caveat.** The default `*.webhook.office.com` glob trusts
any Microsoft subdomain. A subdomain takeover at Microsoft's DNS could
theoretically route alerts to an attacker. Operators with tighter threat models
should narrow the glob (e.g., to their specific tenant subdomain). Update via:

```
wrangler secret put WEBHOOK_HOST_ALLOWLIST
# enter: yourtenant.webhook.office.com,hooks.slack.com,discord.com,discordapp.com
```

**No self-rotating secrets.** The Worker runtime does not hold a Cloudflare
control-plane token and cannot call the CF API to rotate its own secrets.
Rotation is operator-driven: `./scripts/setup.sh --email` or
`./scripts/setup.sh --rotate-admin`. The Settings tab surfaces clear instructions
for one-click-deploy operators without a local clone.

## FAQ

**Why not auto-register the domain when it drops?**
Auto-registration requires a registrar API, credit-card authorization, and a
different threat model (you are now a buyer, not a monitor). v1 is deliberately
monitor-only. See the roadmap for v2 plans.

**Why RDAP instead of WHOIS?**
RDAP is the IANA-standardized JSON successor to WHOIS. It returns structured
data without screen-scraping, supports HTTPS, and most major TLD registries have
published RDAP endpoints. WHOIS format varies by registry, requires port 43, and
rate-limits more aggressively. WHOIS fallback for ccTLDs without RDAP is a v2
roadmap item.

**Can I run this without a Cloudflare account?**
No. The tool is purpose-built for the Cloudflare Workers runtime (D1, KV, cron
triggers). The core logic (`src/rdap.ts`, `src/alerts.ts`) has no CF-specific
imports and could be adapted, but a self-hosted Node.js port is not planned.

**What happens if RDAP is down for a TLD?**
The worker classifies the response as `indeterminate` and does not fire an alert.
The confirmation counter is not advanced. Transient outages cannot produce
false drop-alerts. Sustained outages surface in the Events tab as a run of
`indeterminate` entries for that domain.

**How do I add a ccTLD that isn't supported?**
If the TLD has no RDAP endpoint in the IANA bootstrap file, the worker sets
`tld_supported=0` on the domain row and surfaces a warning in the dashboard.
Check `https://data.iana.org/rdap/dns.json` for your TLD. If it's absent, WHOIS
fallback (v2) is needed.

## Roadmap (v2)

- **WHOIS fallback** for ccTLDs without published RDAP services (`.uk`, `.de`, and others).
- **Auto-register integration** — opt-in, registrar API, separate threat model; credit-card risk is out of scope for v1.
- **Multi-operator RBAC** if the tool grows beyond single-admin deployments.

## Contributing

PRs welcome.

```
git clone https://github.com/oitray/domain-drop-watcher
cd domain-drop-watcher
npm install
npm test          # must pass
npm run typecheck # must pass
```

Conventions:

- No runtime dependencies beyond what ships in `package.json` (wrangler, typescript, vitest, @cloudflare/workers-types). No Hono, no Zod.
- Tests colocated under `test/`, named `<module>.test.ts`. Vitest only.
- TypeScript strict mode (`"strict": true, "noUncheckedIndexedAccess": true`).
- No comments unless they document a non-obvious *why*. Well-named identifiers first.
- `shellcheck scripts/setup.sh` must pass for any `setup.sh` changes.

PR checklist: typecheck passes, tests pass, shellcheck passes for setup.sh changes, no new runtime dependencies.

## License

MIT — see [LICENSE](LICENSE).
