#!/usr/bin/env bash
set -e
# Use a dedicated persist directory for E2E tests so state doesn't bleed between runs
PERSIST_DIR=".wrangler/e2e-state"
# Wipe previous state so each full test run starts fresh
rm -rf "$PERSIST_DIR"
# Apply schema to the fresh local D1
npx wrangler d1 execute domain-drop-watcher --local --persist-to "$PERSIST_DIR" --file=schema.sql
exec npx wrangler dev --port 8787 \
  --persist-to "$PERSIST_DIR" \
  --var EMAIL_STUB:1 \
  --var RDAP_BASE_URL:http://127.0.0.1:9999 \
  --var SESSION_SECRET:playwright-test-secret-not-for-production
