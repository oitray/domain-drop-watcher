# Implementation State

Living document. Every subagent updates this file on completion. Read this before starting.

## Source plan

`/Users/rayorsini/Projects/automations/docs/superpowers/plans/2026-04-22-domain-drop-watcher.md`

Reviewed: Claude x4, Codex x4. All findings addressed. Do NOT re-litigate design decisions documented in the Revisions section — implement to spec.

## ClickUp

- Task: https://app.clickup.com/t/868jc41ep
- Status: implementation (bump to `in progress` after Phase 1 lands)

## Credentials state

| Secret | Vault | Name | Populated |
|---|---|---|---|
| CF API token | occ-secrets-ray | CLOUDFLARE-API-TOKEN | yes |
| CF Account ID | occ-secrets-ray | CLOUDFLARE-ACCOUNT-ID | yes (`41bdca8b6cc070fa21c487ba8a7fab6c`, "OIT") |
| Resend API key | n/a | RESEND_API_KEY | no — operator provides via wizard |
| Admin token | n/a | ADMIN_TOKEN | no — wizard generates |

Token scopes verified: D1:Edit, Workers KV Storage:Edit, Workers Scripts:Edit, Workers Tail:Edit, Workers Observability:Edit, Account Settings:Read, User Details:Read, Memberships:Read. **Account currently has 3 other Workers** — do not collide on naming; use `domain-drop-watcher` prefix.

## Repo state

- GitHub: https://github.com/oitray/domain-drop-watcher (public, MIT, created 2026-04-22)
- Local: `/Users/rayorsini/Projects/domain-drop-watcher`
- Default branch: `main`
- CI: none yet (Phase 9)

## Phase status

Update these checkboxes as you complete work. Include commit SHA.

**All phases complete** — ready for public announcement (2026-04-22).

- [x] Phase 1: Repo skeleton + wrangler config
- [x] Phase 2: D1 helpers + schema + budget module
- [x] Phase 3: RDAP client + status classifier
- [x] Phase 4: Alert channels + webhook SSRF allowlist
- [x] Phase 5: Admin HTTP routes + auth middleware
- [x] Phase 6: Scheduled() cron handler
- [x] Phase 7: Admin dashboard (public/index.html)
- [x] Phase 8: Interactive setup wizard (scripts/setup.sh)
- [x] Phase 9: README + CI workflow

## Conventions subagents must follow

1. **TypeScript strict mode.** `tsconfig.json` uses `"strict": true, "noUncheckedIndexedAccess": true`.
2. **No external dependencies beyond:** `wrangler` (devDep), `typescript` (devDep), `vitest` (devDep), `@cloudflare/workers-types` (devDep). No Hono, no Zod, no Itty — keep the dep graph minimal; handwritten router + hand-rolled validation.
3. **No comments unless they document non-obvious WHY.** Well-named identifiers first.
4. **Commit per phase** with subject prefix `feat:` / `chore:` / `docs:` / `test:` as appropriate. End each commit message with `(868jc41ep)` for ClickUp trace, and Co-Authored-By Claude per global commit format.
5. **Tests colocated under `test/`**, named `<module>.test.ts`. Use `vitest`'s `describe`/`it`/`expect`. No test framework beyond vitest.
6. **Do NOT touch other phases' files.** If you need something a prior phase missed, note it in "Cross-phase blockers" below and stop; do not patch retroactively.
7. **Every phase ends by updating this file** (check the box, add commit SHA, add any notes for downstream phases). This is the handoff contract.

## Cross-phase blockers

(Add items here when a phase uncovers something a previous phase needs to fix.)

_none yet_

## Notes for Phase 9

- `scripts/setup.sh` is operator-only — CI should NOT run it. The wizard requires interactive prompts, wrangler auth, and live CF account access. The `npm run setup` script is for operator use only.
- New test file: `test/setup-sh-shape.test.ts` (12 lint-level assertions). Added `test/raw-shim.d.ts` for `?raw` import type support — required because tsconfig uses `@cloudflare/workers-types` only (no node types). The `?raw` import is a Vite/Vitest feature that returns file contents as a string at build time.
- Test count: 108 (was 96 after Phase 7).
- `package.json` gained two scripts: `setup` and `setup:email`.
- `wrangler.toml` patching uses awk state machine (binding-keyed, not positional). Validates `[assets]` block + `run_worker_first` survive every patch. Atomic: writes to temp file, validates, then `mv` replaces.
- No `eval` in the wizard (removed dynamic variable naming pattern for KV IDs — not needed since IDs go directly to wrangler.toml).

## Notes for future phases

- `tsconfig.json` includes `"skipLibCheck": true` — required because `@cloudflare/workers-types` and vitest's transitive `vite`/`tinybench` deps declare conflicting node types. This is standard for CF Workers + vitest setups. Does not affect runtime correctness.
- Phase 1 commit SHA: `9963351`
- Phase 2 commit SHA: `45b9ae8`
- Phase 3 commit SHA: `2ed1b54`
- Phase 4 commit SHA: `064289f`
- Phase 5 commit SHA: `c6e8d54`
- Phase 6 commit SHA: `7594952`
- Phase 7 commit SHA: `dc64713`
- Phase 8 commit SHA: `020fc90`

## Notes for Phase 7

- `public/index.html` — vanilla JS SPA, ~40KB. No build step, no dependencies. All innerHTML writes use an `esc()` function that HTML-escapes all user-controlled data.
- `ASSETS` binding added to `Env` in `types.ts` as optional `{ fetch: (req: Request) => Promise<Response> }`. Optional because tests don't inject it by default.
- `wrangler.toml` — added `[assets]` block: `directory = "./public"`, `binding = "ASSETS"`, `run_worker_first = true`. The `run_worker_first = true` flag is critical — without it, Cloudflare serves static assets before the Worker sees the request, and the Worker never handles `/api/*`-style or root routes. Preserve this on any Bicep/wrangler changes.
- `GET /` in `admin.ts` now delegates to `env.ASSETS.fetch(req)` and injects CSP/security headers over the response. Falls back to a plain text "deploy with wrangler assets configured" message when ASSETS is absent (e.g. in local tests).
- CSP used: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'`. The `unsafe-inline` is intentional — the dashboard embeds all JS and CSS in a single HTML file for zero-dependency deployment. A future hardening pass could add nonces, but it requires a build step to generate them per-request.
- Test count: 96 (2 new tests in `GET /` describe block; 1 renamed/updated from the Phase 5 placeholder test).
- Phase 8 (setup wizard): `scripts/setup.sh` is a standalone shell script; it uses `wrangler secret put` and D1 SQL for initialization. No Worker-side changes needed.

## Notes for Phase 7+ (original)

- `scheduled()` is fully implemented in `src/worker.ts`. It imports from `./db`, `./kv`, `./rdap`, `./alerts` — no new deps.
- **Indeterminate-during-confirmation semantics:** When `lookupDomain` returns `indeterminate` (or throws), the update for that domain preserves the existing `pending_confirm_status` and `pending_confirm_count` unchanged. Transient RDAP outages do NOT reset or advance the confirmation streak. This is deliberate and tested in `test/scheduled.test.ts` ("indeterminate during confirmation" suite).
- **LIMIT 45** is enforced by `getDueDomains(env.DB, now, 45)`. The D1 mock in `test/scheduled.test.ts` handles both literal (`LIMIT 45`) and parameterized (`LIMIT ?`) SQL so the 45-cap is verified in tests.
- `recordCheckBatch` receives `pendingConfirmStatus`/`pendingConfirmCount` for every row including indeterminate ones — so the D1 batch always has complete data to write.

## Notes for Phase 5+

- `dispatchAlert` calls `recordChannelDelivery` directly from `db.ts` after each channel attempt. Tests inject a no-op D1 stub via `Env.DB` — no refactor needed, pattern is clean.
- `AlertTransition` does NOT have a `rdap` field in `types.ts` (Phase 3 kept it flat). `formatSlackBlocks` and `formatGenericWebhook` cast through `AlertTransition & { rdap?: ... }` to remain forward-compatible. Phase 6 or 3 can add the field to the type without breaking anything.
- `WEBHOOK_HOST_ALLOWLIST_DEFAULT` must be set in `wrangler.toml` (non-secret) with OIT-safe defaults before Phase 5 admin routes go live.

## Notes for Phase 6+

- `handleAdmin` exports cleanly from `src/admin.ts`; `src/worker.ts` now delegates all `fetch()` traffic to it with a top-level try/catch 500 wrapper.
- `AlertTransition` now has `rdap?: { source?: string }` in `types.ts` — Phase 6 can use it directly without casting.
- `Env` now has `VERSION?: string` — wrangler exposes this via `[vars]` in `wrangler.toml`.
- The scheduled cron handler (`worker.ts scheduled()`) is a stub. Phase 6 should: (1) call `getDueDomains(env.DB, now, 45)`; (2) for each, call `lookupDomain`; (3) apply confirmation logic; (4) call `dispatchAlert` on confirmed transitions; (5) call `recordCheckBatch` to update `last_checked_at`/`next_due_at`; (6) call `appendEvent(env.EVENTS, ...)` for status transitions and alert results. Check `getConfig(env.DB, 'global_paused')` at the top of `scheduled()` — return early if `==='1'`.
- Admin test mock D1 uses an in-memory Map-backed object scoped to the SQL patterns in admin.ts. If Phase 6 adds new SQL patterns to `db.ts` functions, the mock may need extension — but Phase 6 tests only need to test the cron handler, not admin routes again.

## Notes for Phase 3+

- `BudgetReport` in `types.ts` was extended with `headroom: number` (Phase 2 needed it; Phase 1 omitted it).
- `DomainRow` keeps snake_case field names (matching D1 column names directly) — db.ts does NOT convert to camelCase on output since the existing type uses snake_case. Future phases should use snake_case field access on `DomainRow`.
- `upsertDomainWithBudgetCheck` uses a recursive CTE to atomically check peak budget and insert. SQLite's `WITH RECURSIVE` default depth limit is 1000; the window is capped at 1440 — Phase 5 (admin routes) should ensure the recursive CTE is only called with D1 (not local SQLite simulators that lack `LIMIT ?` on recursive CTEs). Test this against the actual D1 binding during Phase 9 CI.
- `pickLeastLoadedOffset` returns the lowest-indexed offset that achieves the minimum peak. The spec example with [0,0,1] returns offset 1 (not 2) because offsets 1–4 all tie at peak=2 and 1 is the lowest.
