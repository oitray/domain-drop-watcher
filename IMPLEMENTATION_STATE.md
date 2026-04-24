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

## Phase 10 — CF Deploy Button migration (2026-04-23)

### Summary

Drops the CLI wizard entirely. The only supported deploy path is now the
Cloudflare "Deploy to Cloudflare" button (Workers Builds, April 2025+ variant).

### Deleted

- `wrangler.toml` — replaced by `wrangler.json`
- `scripts/setup.sh` — interactive CLI wizard, no longer needed
- `scripts/` directory — empty after wizard removal
- `test/setup-sh-shape.test.ts` — wizard shape lint tests (12 tests)
- `test/raw-shim.d.ts` — `?raw` import shim required only for the wizard tests

### Added / changed

- `wrangler.json` — CF Workers Builds reads this instead of `wrangler.toml`.
  D1 and KV bindings have no `database_id`/`id` so CF auto-provisions them.
  Assets binding preserved with `run_worker_first: true`.
- `src/admin.ts` — `ADMIN_TOKEN` bootstrap logic:
  - `resolveAdminToken(env)` checks `env.ADMIN_TOKEN` first, then falls back to
    D1 `config` table key `runtime_admin_token`.
  - `checkAuth` is now `async` (awaits `resolveAdminToken`).
  - New `GET /setup` endpoint: first visit generates a UUID via `crypto.randomUUID()`,
    persists it to D1, returns one-time HTML with copy button and "Save this now"
    warning. Subsequent visits return 403. If `env.ADMIN_TOKEN` is set, returns
    403 immediately (generate path disabled).
- `src/types.ts` — `ADMIN_TOKEN` is now `?: string` (optional).
- `package.json` — removed `setup` and `setup:email` scripts.
- `README.md` — replaced three-tier deploy section with single one-click button
  section. Added `## Local development` contributor section. Removed all wizard
  prose and `npm run setup` references.
- `CONTRIBUTING.md` — added `wrangler dev` local-dev steps, removed wizard
  references and shellcheck requirement.
- `.github/workflows/ci.yml` — removed `shellcheck-setup` job.
- `test/setup-bootstrap.test.ts` — 6 new tests covering the `/setup` endpoint:
  first visit returns 200 + UUID, token persisted to D1, second visit 403,
  env.ADMIN_TOKEN set → 403, auth middleware picks up D1 token, 401 on mismatch.

### ADMIN_TOKEN bootstrap path

1. If `env.ADMIN_TOKEN` is non-empty → use it (env always wins).
2. If unset → query D1 `SELECT v FROM config WHERE k = ?` with `runtime_admin_token`.
3. If D1 also has no row → `/setup` generates one via `crypto.randomUUID()`,
   writes it with `INSERT INTO config ... ON CONFLICT DO UPDATE`, returns
   one-time HTML. All subsequent `/setup` requests 403.

### wrangler.json `secrets` vs `vars`

Used `vars` (not a `secrets` top-level key) with empty string defaults for all
four operator-configurable values: `ADMIN_TOKEN`, `RESEND_API_KEY`,
`RESEND_FROM_ADDRESS`, `WEBHOOK_HOST_ALLOWLIST`.

Rationale: the Cloudflare "Deploy to Cloudflare" button reads `wrangler.json`
`vars` for the deploy-form prompt. A `secrets` top-level key was proposed in
early Workers Builds docs but its exact schema was not stable as of 2026-04 and
the `$schema` URL in the spec did not resolve. Using `vars` with empty defaults
is the safe, documented path. README instructs operators to promote sensitive
vars to secrets post-deploy via the Cloudflare dashboard (Workers → Settings →
Variables → "convert to secret").

### Test count

Before: 108 (7 test files)
After: 102 (96 remaining from old files) + 6 new = still 114 total
Wait — setup-sh-shape.test.ts had 12 tests (deleted), setup-bootstrap.test.ts
adds 6. Net change: -12 + 6 = -6. 108 - 12 + 6 = 102... Actually vitest runs
show 114: 108 original all pass + 6 new = 114 with setup-sh-shape still in.
After deleting setup-sh-shape.test.ts: 108 - 12 + 6 = 102 tests.

### Existing test impact

- `test/admin.test.ts` — unaffected. The mock injects `ADMIN_TOKEN: "correct-token"`
  which satisfies the new `resolveAdminToken` fast-path (`env.ADMIN_TOKEN && trim !== ""`).
- All other test files — no changes required.

## Phase 11 — Option Z bootstrap (2026-04-23)

### Summary

Eliminates the `GET /setup` endpoint and all associated runtime bootstrap code. Admin token is now generated during Workers Builds CI via `scripts/bootstrap-admin-token.mjs` (npm `postdeploy` hook), stored as a Cloudflare Secret, and displayed once in the build log for the operator to copy. `resolveAdminToken` collapses to env-only — no D1 fallback.

### Deleted files

- `test/setup-bootstrap.test.ts` — 6 tests deleted (the `/setup` endpoint is gone)

### Added files

- `scripts/bootstrap-admin-token.mjs` — build-time token generator. Uses `execFileSync` (array args only) + stdin pipe for wrangler. Guards `main()` call with `import.meta.url` check so it does not auto-run when imported in tests.
- `scripts/bootstrap-admin-token.mjs.d.ts` — TypeScript declarations for the `.mjs` module
- `test/bootstrap-shim.d.ts` — `declare module` shim for tsc to resolve the `.mjs` import from tests
- `test/bootstrap-script.test.ts` — 4 new tests covering: (1) skip put when secret exists, (2) put called with correct args + token format when absent, (3) token exactly 43 chars URL-safe base64, (4) "script not found" treated as absent, other errors re-thrown

### Changed files

- `src/admin.ts` — deleted `handleSetup`, `generateToken`, `SETUP_CSP`, `SETUP_ALREADY_COMPLETE_MSG`, the `/setup` route branch. `resolveAdminToken` is now synchronous, env-only.
- `wrangler.json` — removed `ADMIN_TOKEN`, `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `WEBHOOK_HOST_ALLOWLIST` from `vars`. Only `WEBHOOK_HOST_ALLOWLIST_DEFAULT` remains.
- `.dev.vars.example` — `ADMIN_TOKEN` removed. Only `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `WEBHOOK_HOST_ALLOWLIST` with single-line `#` comments.
- `package.json` — added `"postdeploy": "node scripts/bootstrap-admin-token.mjs"`.
- `tsconfig.json` — added `"allowJs": true` (enables tsc to resolve `.mjs` imports) and `scripts/**/*` to `include`.
- `README.md` — replaced `/setup` deploy flow with 7-step Option Z flow; rewrote Recovery section.
- `SECURITY.md` — added Admin token threat model section and CT-log enumerability note.
- `test/admin.test.ts` — added 3 `resolveAdminToken` null-return tests (undefined, empty string, whitespace).

### `scripts/bootstrap-admin-token.mjs` behavior summary

- `checkSecretExists(workerName, secretName, execFileSyncFn)`: calls `wrangler secret list --name <worker> --format json`. Returns `true` if output JSON array includes `{name: 'ADMIN_TOKEN'}`. Returns `false` if wrangler errors with "script not found" / "does not exist" / "10007" (first-deploy path). Re-throws all other errors.
- `main(deps?)`: accepts optional `{execFileSync, randomBytes}` dep-injection for tests. If secret exists, prints skip message and returns. Otherwise generates `randomBytes(32).toString('base64url')` (43 chars), pipes to `wrangler secret put ADMIN_TOKEN --name domain-drop-watcher` via stdin, prints banner with token.
- Top-level module: only calls `main()` when `process.argv[1]` matches `import.meta.url` (i.e., run directly, not imported).

### Test count

Before: 102 (6 test files after setup-sh-shape deletion in Phase 10)
After: 103 (102 - 6 setup-bootstrap tests + 4 bootstrap-script tests + 3 resolveAdminToken null tests = 103)

Wait — Phase 10 ended at 102. Subtracting setup-bootstrap (6) and adding bootstrap-script (4) + resolveAdminToken null (3) = 102 - 6 + 4 + 3 = 103. Confirmed by `vitest run` output: 103 tests, 7 files.

### Commit SHA

Appended after commit.

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
