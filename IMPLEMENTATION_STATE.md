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

- [x] Phase 1: Repo skeleton + wrangler config
- [x] Phase 2: D1 helpers + schema + budget module
- [x] Phase 3: RDAP client + status classifier
- [x] Phase 4: Alert channels + webhook SSRF allowlist
- [ ] Phase 5: Admin HTTP routes + auth middleware
- [ ] Phase 6: Scheduled() cron handler
- [ ] Phase 7: Admin dashboard (public/index.html)
- [ ] Phase 8: Interactive setup wizard (scripts/setup.sh)
- [ ] Phase 9: README + CI workflow

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

## Notes for future phases

- `tsconfig.json` includes `"skipLibCheck": true` — required because `@cloudflare/workers-types` and vitest's transitive `vite`/`tinybench` deps declare conflicting node types. This is standard for CF Workers + vitest setups. Does not affect runtime correctness.
- Phase 1 commit SHA: `9963351`
- Phase 2 commit SHA: `45b9ae8`
- Phase 3 commit SHA: `2ed1b54`
- Phase 4 commit SHA: (set after commit)

## Notes for Phase 5+

- `dispatchAlert` calls `recordChannelDelivery` directly from `db.ts` after each channel attempt. Tests inject a no-op D1 stub via `Env.DB` — no refactor needed, pattern is clean.
- `AlertTransition` does NOT have a `rdap` field in `types.ts` (Phase 3 kept it flat). `formatSlackBlocks` and `formatGenericWebhook` cast through `AlertTransition & { rdap?: ... }` to remain forward-compatible. Phase 6 or 3 can add the field to the type without breaking anything.
- `WEBHOOK_HOST_ALLOWLIST_DEFAULT` must be set in `wrangler.toml` (non-secret) with OIT-safe defaults before Phase 5 admin routes go live.

## Notes for Phase 3+

- `BudgetReport` in `types.ts` was extended with `headroom: number` (Phase 2 needed it; Phase 1 omitted it).
- `DomainRow` keeps snake_case field names (matching D1 column names directly) — db.ts does NOT convert to camelCase on output since the existing type uses snake_case. Future phases should use snake_case field access on `DomainRow`.
- `upsertDomainWithBudgetCheck` uses a recursive CTE to atomically check peak budget and insert. SQLite's `WITH RECURSIVE` default depth limit is 1000; the window is capped at 1440 — Phase 5 (admin routes) should ensure the recursive CTE is only called with D1 (not local SQLite simulators that lack `LIMIT ?` on recursive CTEs). Test this against the actual D1 binding during Phase 9 CI.
- `pickLeastLoadedOffset` returns the lowest-indexed offset that achieves the minimum peak. The spec example with [0,0,1] returns offset 1 (not 2) because offsets 1–4 all tie at peak=2 and 1 is the lowest.
