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
- [ ] Phase 2: D1 helpers + schema + budget module
- [ ] Phase 3: RDAP client + status classifier
- [ ] Phase 4: Alert channels + webhook SSRF allowlist
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
- Phase 1 commit SHA: see git log
