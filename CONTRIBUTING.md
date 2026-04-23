# Contributing

## Setup

```
git clone https://github.com/oitray/domain-drop-watcher
cd domain-drop-watcher
npm install
```

## Run tests

```
npm test          # vitest run (all test files under test/)
npm run typecheck # tsc --noEmit
```

Both must pass before opening a PR.

## Coding conventions

- **No new runtime dependencies.** The dep graph is intentionally minimal:
  `wrangler`, `typescript`, `vitest`, `@cloudflare/workers-types` — all devDeps.
  No Hono, no Zod, no Itty. Handwritten router and hand-rolled validation only.
- **TypeScript strict mode.** `tsconfig.json` sets `"strict": true` and
  `"noUncheckedIndexedAccess": true`. No `any` casts without a comment explaining why.
- **No comments unless they document a non-obvious *why*.** Well-named identifiers
  come first. Delete comments that restate the code.
- **Tests colocated under `test/`**, named `<module>.test.ts`. Use vitest's
  `describe`/`it`/`expect`. No other test framework.
- **Shell scripts** — `shellcheck scripts/setup.sh` must pass. Any new shell
  scripts follow the same `set -euo pipefail`, no-eval, quoted-expansions baseline
  as the existing wizard.

## PR checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (108 tests currently; add tests for new logic)
- [ ] `shellcheck scripts/setup.sh` passes if `setup.sh` was changed
- [ ] No new runtime dependencies added
- [ ] No secrets or credentials in any file
