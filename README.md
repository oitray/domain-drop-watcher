# domain-drop-watcher

> Watch domains. Catch drops. Beat the typosquatters.

[![CI](https://github.com/oitray/domain-drop-watcher/actions/workflows/ci.yml/badge.svg)](https://github.com/oitray/domain-drop-watcher/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Runs on Cloudflare Workers (free tier)](https://img.shields.io/badge/Runs%20on-Cloudflare%20Workers%20free%20tier-orange?logo=cloudflare)](https://developers.cloudflare.com/workers/)

> **Recommended: fork first.** This button deploys directly from `oitray/domain-drop-watcher` `main`. Cloudflare Workers Builds will redeploy your Worker on every push to this upstream repo. For production stability, fork this repo first and click the deploy button on your fork's README — you control when upstream changes land.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/oitray/domain-drop-watcher)

One click. No CLI. Works on Windows, macOS, and Linux. Full setup details below.

## About

Domain Drop Watcher is a FOSS, self-hosted tool that watches a list of domains and alerts you the instant any of them enters `pendingDelete`, `redemptionPeriod`, or becomes available for re-registration. It runs as a single Cloudflare Worker on the free tier — no servers, no SaaS, no per-domain fees.

### Why this exists

This project was created for my buddy who owns a tiny tractor and a regular-sized plane. He said this would be a cool thing so I built a cool thing. It's likely going to be helpful to other MSPs as well. So it's FOSS. Enjoy.

— Ray

### The use case it prevents

A client gets repeatedly typosquatted by the same attacker. The registrar takes the malicious domain down on an abuse complaint — then releases it back into the pool rather than transferring ownership. The attacker grabs it again within minutes, sometimes at a different registrar. Rinse, repeat.

Commercial drop-catchers (DropCatch, SnapNames, Park.io, Dynadot Backorder) charge per domain and target *domainers* — people trying to snipe expiring inventory for resale — not defenders trying to protect a client's brand. They're also SaaS you'd be handing your watch-list to. No FOSS, self-hostable, defender-oriented option existed.

This tool fills that gap. Deploy it on your own Cloudflare account in 90 seconds, watch as many domains as you need, get alerts wherever you already operate (email / Teams / Slack / Discord / any webhook). No third party sees your watchlist.

## Features

- **Detects drops before attackers do.** Polls RDAP on the authoritative registry for each TLD, catches `pendingDelete` / `redemptionPeriod` / `pendingRestore` transitions the moment they appear, and flags domains that become available.
- **Fires alerts everywhere you operate.** Email (via Cloudflare Email Routing — no external service), Microsoft Teams, Slack, Discord, and generic JSON webhooks. Mix and match channels per domain.
- **One-click deploy, zero config.** Browser-only install on Windows / macOS / Linux. No CLI, no DNS, no API keys unless you want them. Admin token auto-generated and printed once in the build log.
- **Scales to hundreds of domains on the free tier.** 225 domains at 5-min cadence, 675 at 15-min, 2,700 at 60-min — all inside Cloudflare's free limits. See the scale table below.
- **Browser-based admin dashboard.** Add/remove domains, configure channels, preview budget impact, watch event history — all from a vanilla-JS SPA served by the Worker itself.
- **False-alert-resistant.** Two-run confirmation gate means transient RDAP outages can't trigger a false drop alert. Per-domain alert dedupe prevents duplicate pages.
- **SSRF-hardened webhooks.** Canonicalized host-glob allowlist (Teams / Slack / Discord out of the box), literal IPs and non-HTTPS rejected unconditionally. Operator-extendable.
- **Per-domain cadence.** Watch high-risk domains every minute, others every hour. Scheduler is budget-aware and auto-assigns least-loaded phase offsets so you never blow the free-tier subrequest ceiling.
- **Bulk add with preview.** Paste a list of domains, see the accepted/rejected split + budget-before/after, commit when you're happy.
- **Dogfood MIT-licensed FOSS.** No per-domain fees, no SaaS dependency, no watch-list data leaving your Cloudflare account.

## Scale on the free tier

Daily check volume is constant (one cron per minute × up to 45 domains = ~64,800 checks/day regardless of watchlist size). Per-domain cadence controls *which* domains are checked each minute, not how many — so a longer cadence lets you watch more domains.

| Cadence | Max domains (free tier) | Use case |
|---------|-------------------------|----------|
| 1 min   | 45                      | Actively-attacked domains you expect to drop today |
| 5 min   | 225                     | Typical high-priority client watchlist |
| 15 min  | 675                     | Standard MSP client portfolio |
| 60 min  | 2,700                   | Broad defensive watchlist (monitoring-only) |

Mix cadences freely — the scheduler handles the math. The live `/budget` endpoint shows exact headroom for your deployment.

## 100% free on Cloudflare

Every piece of this runs inside Cloudflare's free tier, with no credit card required:

| Service | Used for | Free-tier limit |
|---------|----------|-----------------|
| Workers | Request + cron handlers | 100,000 requests/day |
| Cron Triggers | Per-minute scheduler | 5 triggers/account (we use 1) |
| D1 | Domain state + schedule | 5 GB, 5M reads/day, 100k writes/day |
| Workers KV | Event log + IANA cache | 1 GB, 100k reads/day, 1k writes/day |
| Workers Builds | CI for deploys | 500 builds/month |
| Email Routing `send_email` | Alert delivery | No published send quota; destination addresses must be verified in your CF account |
| Static Assets | Admin dashboard hosting | Included with Worker, free and unlimited |

No external services, no API keys, no monthly bills. For typical MSP watchlists (tens to hundreds of domains), this workload sits comfortably inside these limits.

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
|  Bearer-auth       |     dedupe + fan out       |  - Email Routing  |
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

> **Recommended: fork first.** The button below deploys directly from `oitray/domain-drop-watcher` `main`. Cloudflare Workers Builds will redeploy your Worker on every push to this upstream repo. For production stability, fork this repo to your own GitHub account first, then click the deploy button on your fork's README. You control when upstream changes land by pulling them into your fork.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/oitray/domain-drop-watcher)

1. Click the button (on your fork, per the note above).
2. Sign in to your Cloudflare account (or create a free one).
3. Authorize the Cloudflare Workers Builds GitHub App to fork this repo into your GitHub account. See **What you're authorizing** below.
4. Optionally fill in `ALERT_FROM_ADDRESS` as a Secret in the deploy form if you want email alerts (must be @ a domain with Cloudflare Email Routing enabled). Leave blank for Teams/Slack/Discord webhooks only. No other fields are required.
5. Click Deploy. Cloudflare provisions a D1 database and two KV namespaces automatically. The `postdeploy` script applies `schema.sql` to the D1 database and generates your admin tokens — no manual step required.
6. Watch the build log stream in the Cloudflare dashboard. Near the end, the build script prints a banner containing your auto-generated admin token. Copy it.
7. **Visit your Worker URL** — shown at the top of the Cloudflare dashboard's Worker page as `https://<name>.<account>.workers.dev`. That's your admin dashboard. Paste the token from step 6 into the login card to enter.

The admin token is generated during Workers Builds CI and stored as a Cloudflare Secret (encrypted at rest). It never appears in any HTTP response. Build logs are scoped to your Cloudflare account — the same trust boundary that already permits Secret reads.

### CLI deploy (wrangler)

If you deploy via CLI instead of the "Deploy to Cloudflare" button, `npm run deploy` handles everything — `wrangler deploy` pushes the Worker, then `postdeploy` applies the schema and generates secrets. No manual `wrangler d1 execute` step is needed.

If you need to apply the schema separately (e.g., after a fresh `wrangler deploy` without `npm run`), run:

```bash
# First deploy or after any schema.sql change — safe to re-run (all statements use IF NOT EXISTS)
wrangler d1 execute domain-drop-watcher --file=schema.sql --remote

# Local development
wrangler d1 execute domain-drop-watcher --file=schema.sql --local --persist-to .wrangler/state
```

> **Note on build-log retention.** Build logs are retained by Cloudflare per their Workers Builds policy. If you want a fresh exposure window, rotate periodically after first login: `wrangler secret put ADMIN_TOKEN --name domain-drop-watcher` (enter your own value), then redeploy.

> **What you're authorizing**
>
> The "Deploy to Cloudflare" button uses Cloudflare's Workers Builds GitHub App. When you authorize it, Cloudflare gets:
> - `contents: read/write` on the forked repo (to push generated `wrangler.json` updates)
> - `workflows: write` (to manage CI)
> - `metadata: read` (always required)
>
> You can scope the app to just this repo (recommended) — Cloudflare's authorization page lets you pick "Only select repositories" instead of "All repositories." Pick "Only select repositories" and choose your fork.

That is it. Roughly 90 seconds, browser-only.

### What just got deployed

- A Cloudflare Worker at `https://<name>.<account>.workers.dev`
- A D1 database (SQLite, free tier)
- Two KV namespaces (free tier)
- A cron trigger running every minute
- `ADMIN_TOKEN` and `SESSION_SECRET` generated by the build script and stored as Cloudflare Secrets

### Secret reference

| Variable | Required | Notes |
|----------|----------|-------|
| `ALERT_FROM_ADDRESS` | No | Sender address for email alerts (e.g. `dropwatch@yourmsp.com`). Must be @ a domain you have enabled Cloudflare Email Routing on. Leave blank if you only need Teams/Slack/Discord webhooks. Required for email-code login. |
| `WEBHOOK_HOST_ALLOWLIST` | No | Comma-separated hostname globs for the webhook SSRF allowlist. Defaults to Teams, Slack, and Discord. Override to restrict or extend. |
| `WEBAUTHN_RP_ID` | No | Override the WebAuthn Relying Party ID. Defaults to the Worker's hostname. Set this if you deploy under a custom domain so passkey challenges bind to the correct origin. |

`ADMIN_TOKEN` and `SESSION_SECRET` are not deploy-form fields. The build script generates both automatically and stores them as Cloudflare Secrets. You do not set them at deploy time.

### Email alerts via Cloudflare Email Routing (optional)

Email alerts use Cloudflare's native `send_email` binding — no external service, no API key, no DNS required beyond enabling Email Routing on a domain you already control.

**1. Enable Email Routing on a domain in your Cloudflare account.** Dashboard → Email → Email Routing → pick a domain → **Enable Email Routing**. CF auto-configures MX records if the domain is on Cloudflare nameservers. One-click.

**2. Add your destination address(es).** In Email Routing → Destination Addresses → **Add destination address**. Enter where alerts should go (e.g. `tickets@yourmsp.com` or your PSA's inbox). CF emails a verification link to that address. Click it once.

**3. Set `ALERT_FROM_ADDRESS`.** In the deploy form OR via Dashboard → Workers & Pages → your worker → Settings → Variables → Add Variable. Use any address @ the Email-Routing-enabled domain (e.g. `dropwatch@yourmsp.com`). This is the sender shown on alert emails.

**4. Add an email channel in the dashboard.** Channels tab → Add channel → type: email, target: your verified destination address. Done.

That's it. No DNS records, no SPF, no DKIM, no monthly email cap — just Cloudflare's native Email Routing. Works with any address you've verified as a destination on your account.

> **Why not a third-party email service (Resend/Postmark/SendGrid)?** MSPs email themselves (tickets@, alerts@, PSA inboxes) — a fixed set of destinations you already own. Cloudflare's `send_email` binding is purpose-built for that pattern and free. Third-party email services add a signup, an API key, SPF/DKIM DNS records, and a monthly send cap. CF Email Routing skips all of that.

## Recovery

- **Lost admin token** — **Delete the `ADMIN_TOKEN` Secret AND redeploy in a single session.** Deleting without redeploying locks you out until the next deploy regenerates a new token.
  1. Cloudflare dashboard → Workers & Pages → `domain-drop-watcher` → Settings → Variables and Secrets
  2. Delete the `ADMIN_TOKEN` Secret (red trash icon) — or run `wrangler secret delete ADMIN_TOKEN --name domain-drop-watcher` from a clone
  3. Trigger a new deploy (push any commit to the fork, or click "Deploy" in the dashboard)
  4. Copy the new token from the build log
  5. Log in with the new token

- **Compromised admin token** — same rotation procedure above. The old token is invalidated the moment the new Secret takes effect.

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

**Where to find it:** `https://<your-worker-name>.<your-cf-account>.workers.dev/` — the same URL Cloudflare shows at the top of your Worker's page in the CF dashboard. The admin dashboard is served directly from the root path; there's no separate login URL, no port, no path suffix. Open the URL, paste your admin token into the login card, done.

The admin dashboard is a vanilla-JS single-page app served by the Worker itself (source: `public/index.html`). No build step, no external assets, no third-party scripts.

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
| Email | Cloudflare Email Routing `send_email` | Destination must be verified in Email Routing. Set `ALERT_FROM_ADDRESS` to a sender @ your Email-Routing-enabled domain. No API key, no DNS setup, no monthly cap. |
| Microsoft Teams | Incoming webhook | Auto-detected via `*.webhook.office.com` host; formatted as MessageCard with `#e42e1b` accent. |
| Slack | Incoming webhook | Auto-detected via `hooks.slack.com`; formatted as Block Kit blocks. |
| Discord | Incoming webhook | Auto-detected via `discord.com/api/webhooks`; formatted as embed with `#e42e1b` color. |
| Generic webhook | POST JSON | Any HTTPS endpoint on your allowlist. Payload: `{fqdn, oldStatus, newStatus, detectedAt, rdap}`. |

All channels fan out in parallel via `Promise.allSettled` — one failed delivery
does not block the others.

## Multi-user access

Domain Drop Watcher supports named, individual logins so MSP teams can share a deployment without sharing one static token.

### Auth modes

| Mode | When it's used |
|------|---------------|
| **Email code** (primary) | Operator types their email; a 6-digit code arrives in the subject line; they type it back. No URLs in the email — defeating corporate mail-scanner pre-consumption (Proofpoint, Defender, Mimecast follow links automatically; typed codes sidestep this entirely). |
| **Passkey** (optional hardening) | After logging in at least once, an operator can register a WebAuthn credential (Touch ID, Face ID, YubiKey, platform passkey) for phishing-resistant repeat logins via the Settings → Passkeys tab. |
| **Bearer break-glass** | `Authorization: Bearer <ADMIN_TOKEN>` still works on every route. Intended for API scripts and lockout recovery. Every state-changing POST using this path is logged with IP and User-Agent. |

All three modes are available simultaneously. Session cookies (12-hour TTL, HttpOnly, Secure, SameSite=Lax) replace the old sessionStorage token.

### First-user bootstrap

1. Deploy. The build log prints an `ADMIN_TOKEN` banner and a `SESSION_SECRET` banner.
2. Visit your worker URL — `/login`. If no users are configured yet, a yellow banner reads "No users configured yet. Use your ADMIN_TOKEN below to log in." The break-glass field auto-expands.
3. Paste the `ADMIN_TOKEN` and submit. You are logged in via break-glass.
4. Go to **Settings → Users → Add user**. Enter your email address.
5. Log out, then sign in with your email: type it in the form, wait for the 6-digit code, type the code.
6. Optionally: **Settings → Passkeys → Register** to enroll a passkey for future logins.
7. Optionally: retire the bearer token by deleting the `ADMIN_TOKEN` Secret in the Cloudflare dashboard. **Strongly recommended to keep it set** as a lockout-recovery path.

### Managing users and sessions

All user management is in the dashboard under **Settings**.

- **Add a user** — Settings → Users → Add user. Enter the email address. The user can sign in immediately.
- **Revoke a session** — Settings → Sessions. Every active session (your own and, if you are an admin, others') is listed with auth method, IP, and browser. Click Revoke on any row.
- **Revoke all sessions for a user** — Settings → Users → the user row → Revoke all sessions.
- **Disable a user** — Settings → Users → Disable. The user's existing sessions stay alive until they expire; new sign-in attempts return 202 (enumeration-safe) but no code is sent.
- **Remove a passkey** — Settings → Passkeys → Delete on the credential row.

The same operations are available via the API (authenticated session or bearer token):

```
POST /users               {email}             add a user
DELETE /users/:email                          remove user + cascade delete their sessions/passkeys
POST /users/:email/disable                    disable login
POST /users/:email/enable                     re-enable login
GET  /sessions                                list active sessions
DELETE /sessions/:session_id                  revoke one session
POST /sessions/revoke-all                     revoke all your sessions (logout everywhere)
POST /users/:email/sessions/revoke-all        admin: revoke all sessions for a specific user
GET  /passkeys                                list your passkeys
DELETE /passkeys/:credential_id              remove a passkey
```

### Lockout recovery

The bearer `ADMIN_TOKEN` is the break-glass of last resort. As long as `ADMIN_TOKEN` is set as a Cloudflare Secret, you can always regain access: paste it in the break-glass field on `/login`. From there you can add yourself back to the user allowlist or re-enroll a passkey.

If `ADMIN_TOKEN` itself is lost, follow the [Recovery](#recovery) section — delete the Secret and redeploy to generate a new one.

**Operators are strongly encouraged to keep `ADMIN_TOKEN` set** even after setting up email-code or passkey auth. Deleting it removes the only recovery path if you lose email access and have no enrolled passkey.

## Accessing the admin dashboard

Visit your Worker URL — `https://<name>.<account>.workers.dev/`. You land on `/login`. Sign in with your email address (a 6-digit code will arrive in the subject line), a registered passkey, or the bearer `ADMIN_TOKEN` via the break-glass section.

On first deploy before any users are added, the break-glass section is automatically expanded with a prompt to add the first user.

**Every request against `/domains`, `/channels`, `/budget`, `/events`, `/check/*`** requires authentication — either a valid session cookie or `Authorization: Bearer <ADMIN_TOKEN>`. A wrong or missing credential returns 401. The 256-bit generated token is infeasible to brute-force (keyspace ~10^77).

### Harden further with Cloudflare Access (recommended for team use)

The default `*.workers.dev` URL is publicly reachable, which means the login card is visible to anyone who discovers the URL via Certificate Transparency logs. The admin token alone is enough to keep them out, but if you want the dashboard to be completely invisible to the public internet — and you want SSO, 2FA, or per-operator login audit trails — put [Cloudflare Access (Zero Trust)](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/) in front of it. **Free for up to 50 users.**

Setup (~5 minutes, all in the CF dashboard):

1. **Cloudflare Dashboard → Zero Trust → Access → Applications → Add an application → Self-hosted**
2. **Application domain**: your Worker URL (`<name>.<account>.workers.dev` or a custom domain if you've added one)
3. **Identity provider**: pick one — One-time PIN (email link, no setup), Google, GitHub, Okta, Azure AD, or any SAML/OIDC provider
4. **Access policy**: e.g. "Require email ending in `@yourmsp.com`" or "Include: specific emails: you@yourmsp.com"
5. Save. Access is live immediately.

After enabling, visiting your Worker URL shows Cloudflare's login page first. Only after identity verification does traffic reach the Worker. The admin token still protects API routes as defense-in-depth — so even an attacker who bypasses Access (e.g. a compromised SSO session) still faces the bearer-token wall.

### Rotate the admin token anytime

See [Recovery](#recovery) above. One-click: delete the Secret, redeploy, copy the new banner.

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
Rotation is operator-driven via the Cloudflare dashboard: Workers → your worker
→ Settings → Variables. The Settings tab in the admin dashboard surfaces clear
instructions.

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
- **Multi-operator RBAC** — per-user roles (read-only vs admin). Schema already includes a `role` column; enforcement is v2 work.

## Local development

Contributors can run the Worker locally with `wrangler dev`:

    git clone https://github.com/oitray/domain-drop-watcher
    cd domain-drop-watcher
    npm install
    npm run dev

Before the first local run, seed the schema into the local D1 emulator:

    wrangler d1 execute domain-drop-watcher --file=schema.sql --local --persist-to .wrangler/state

This is a one-time step per local workspace. Re-run it after any `schema.sql` change (safe — all statements use `IF NOT EXISTS`). Create a `.dev.vars` file with placeholder secrets (see `.dev.vars` in `.gitignore`) so the Worker starts without real Cloudflare credentials.

This runs against `wrangler`'s local emulator. No Cloudflare account required for code changes. See CONTRIBUTING.md for full setup.

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

PR checklist: typecheck passes, tests pass, no new runtime dependencies.


## License

MIT — see [LICENSE](LICENSE).
