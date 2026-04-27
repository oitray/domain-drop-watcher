#!/usr/bin/env bash
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/tmp/template-build/domain-drop-watcher-template}"
TAG="${2:-$(git -C "$SRC" describe --tags --abbrev=0 2>/dev/null || echo v0.0.0)}"

rm -rf "$OUT"
mkdir -p "$OUT"

# Copy source, excluding internal artifacts AND playwright (CF templates' Playwright lives in monorepo root, not in template subdir)
rsync -a \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'docs/superpowers/' \
  --exclude 'docs/inventories/' \
  --exclude 'docs/plans/' \
  --exclude 'docs/runbooks/' \
  --exclude 'IMPLEMENTATION_STATE.md' \
  --exclude '.claude/' \
  --exclude 'working/' \
  --exclude '.dev.vars' \
  --exclude '.dev.vars.example' \
  --exclude '.env.example' \
  --exclude 'docs/img/demo.gif' \
  --exclude 'playwright.config.ts' \
  --exclude 'playwright-tests/' \
  --exclude 'scripts/build-template.sh' \
  --exclude 'scripts/template-readme.mustache' \
  --exclude 'scripts/template-package.json' \
  "$SRC/" "$OUT/"

# Strip the OIT-specific demo env block from wrangler.json (demo env has custom_domains + OIT email)
node -e "
  const fs=require('fs');
  const w=JSON.parse(fs.readFileSync('$OUT/wrangler.json','utf8'));
  delete w.env;
  fs.writeFileSync('$OUT/wrangler.json',JSON.stringify(w,null,2)+'\n');
"

# Inject CF metadata into package.json
node -e "
  const fs=require('fs');
  const pkg=JSON.parse(fs.readFileSync('$OUT/package.json','utf8'));
  const meta=JSON.parse(fs.readFileSync('$SRC/scripts/template-package.json','utf8'));
  pkg.name=meta.name;
  pkg.description=meta.description;
  pkg.cloudflare=meta.cloudflare;
  pkg.private=true;
  // Strip vitest + playwright + wrangler scripts that don't apply to template
  delete pkg.scripts['test:e2e'];
  delete pkg.scripts['test:rdap-fixture'];
  fs.writeFileSync('$OUT/package.json',JSON.stringify(pkg,null,2)+'\n');
"

# Rewrite CONTRIBUTING.md clone URL to the generic template path (no OIT-specific fork URL)
if [ -f "$OUT/CONTRIBUTING.md" ]; then
  sed -e 's|github\.com/oitray/domain-drop-watcher|github.com/cloudflare/templates/tree/main/domain-drop-watcher-template|g' \
    "$OUT/CONTRIBUTING.md" > "$OUT/CONTRIBUTING.md.tmp" && mv "$OUT/CONTRIBUTING.md.tmp" "$OUT/CONTRIBUTING.md"
fi

# Render the README from the mustache template via sed.
# NOTE: no -i flag here — we redirect to a new file so this is portable across BSD/macOS and GNU/Linux.
# Any other in-place edits MUST use the portable form: `sed -i.bak '...' file && rm -f file.bak`.
TEMPLATE="$SRC/scripts/template-readme.mustache"
sed -e "s/{{TAG}}/$TAG/g" -e "s|{{REPO_URL}}|https://github.com/oitray/domain-drop-watcher|g" "$TEMPLATE" > "$OUT/README.md"

if [ -f "$SRC/docs/img/dashboard.png" ]; then
  cp "$SRC/docs/img/dashboard.png" "$OUT/dashboard.png"
else
  echo "WARN: dashboard.png missing — skipping (will need to be added before first CF templates PR)"
fi

# Regenerate the template lockfile from the rewritten package.json so the lockfile matches.
# cloudflare/templates uses pnpm (`pnpm fix:lockfiles` in their CONTRIBUTING) — run pnpm in OUT/, not npm,
# so the committed lockfile shape matches what their CI verifies. --lockfile-only avoids materializing node_modules.
if command -v pnpm >/dev/null 2>&1; then
  ( cd "$OUT" && pnpm install --lockfile-only --reporter=silent )
else
  echo "WARN: pnpm not found — skipping lockfile generation (install pnpm before submitting CF templates PR)"
fi

# Required: .gitignore must exist per CF spec
[ -f "$OUT/.gitignore" ] || cp "$SRC/.gitignore" "$OUT/.gitignore"

# HARD debrand check: any remaining branding outside the README attribution line FAILS the build.
RESIDUALS=$(LANG=C find "$OUT" -type f \( -name '*.ts' -o -name '*.js' -o -name '*.mjs' -o -name '*.json' -o -name '*.md' -o -name '*.html' -o -name '*.sql' \) \
  -exec grep -lI 'OIT\|oitray\|@oit\.co\|oit\.co\|oitlabs' {} + 2>/dev/null | grep -v "^$OUT/README.md\$" || true)

if [ -n "$RESIDUALS" ]; then
  echo "ERROR: residual branding detected in:"
  echo "$RESIDUALS"
  exit 1
fi

echo "Built template at $OUT (tag: $TAG)"
