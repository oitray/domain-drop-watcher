# Contributing

## Setup

```
git clone https://github.com/oitray/domain-drop-watcher
cd domain-drop-watcher
npm install
```

## Local dev

Run the Worker against the local wrangler emulator:

```
npm run dev
```

No Cloudflare account required for code changes. The emulator starts on
`http://localhost:8787`. Use `.dev.vars` (copy from `.dev.vars.example`) to
inject environment bindings locally.

`wrangler deploy` is available for contributors testing deploy behavior against
a real Cloudflare account, but it is not the documented operator path — operators
use the one-click deploy button. See README for the operator flow.

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

## PR checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (add tests for new logic)
- [ ] No new runtime dependencies added
- [ ] No secrets or credentials in any file
