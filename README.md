# domain-drop-watcher

A Cloudflare Worker that polls domain registration state via RDAP, detects status changes (`pendingDelete`, `redemptionPeriod`, available), and fires alerts to email and webhook channels. Designed for MSPs who need to catch a domain drop and register it before an attacker does — without paying per-domain backorder fees.

![CI](https://github.com/oitray/domain-drop-watcher/actions/workflows/ci.yml/badge.svg)

**Status: early development** — Phase 1 skeleton in place; see implementation plan for progress.

Plan: `/Users/rayorsini/Projects/automations/docs/superpowers/plans/2026-04-22-domain-drop-watcher.md`
