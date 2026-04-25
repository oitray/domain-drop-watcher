---
title: domain-drop-watcher — Magic-link + Passkey Auth (multi-user, CF-free, no SSO)
clickup: https://app.clickup.com/t/868jd3n6k
codex_passes: 3
claude_passes: 2
status: planning
repo: github.com/oitray/domain-drop-watcher
created: 2026-04-24
supersedes: none (adds to existing bearer-token flow from 2026-04-23-dropwatch-secure-bootstrap.md)
---

Claude Review(s): 2 (pass 1: HOLD→GO after 4 blockers + 10 important fixed; pass 2: GO, 4 minor notes addressed inline)
Codex Review(s): 3 (pass 1: HOLD, 5 blockers addressed; pass 2: HOLD, 3 blockers addressed incl. cleanup cron + tightened rate limit + Origin explicitness; pass 3: GO after scrubbing stale contradictions)

# domain-drop-watcher — Magic-link + Passkey Auth

## Context

The tool currently authenticates all admin routes via a single shared bearer token (`ADMIN_TOKEN`), auto-generated at deploy and stored as a CF Secret. That works for solo operators but has three real gaps for MSP teams:

1. **No multi-user support.** Sharing one bearer token across a team means no individual accountability and no way to revoke access when someone leaves.
2. **Session UX friction.** The 43-char token has to be pasted into the login card every session (sessionStorage clears on tab close).
3. **No audit trail.** Every API call looks the same — no way to see who did what.

Ray confirmed: operators who use SSO can add Cloudflare Access in front (already documented, free for 50 users). This plan serves the non-SSO cohort — MSPs who don't have or don't want to deploy an IdP in front of this tool.

**Goal:** first-class multi-user auth directly in the tool, using only Cloudflare's free tier and no SaaS. Two modes, both available simultaneously:

- **One-time-code email auth** (primary): operator types their email, receives a 6-digit code in an email, types it back into the login page. Uses CF Email Routing — same infrastructure we already use for alerts. Code-based (not URL-based) to defeat corporate mail scanner pre-consumption — Proofpoint / Microsoft Defender / Mimecast automatically follow every URL in incoming mail, which would eat one-time-use tokens before the operator could click them. A typed code has no URL for the scanner to consume.
- **Passkey auth** (optional hardening): operator can register a WebAuthn credential (Touch ID, YubiKey, platform passkey) for phishing-resistant repeat logins.

Bearer-token auth stays as a **break-glass** for API scripts and initial bootstrap.

**Non-goals:**
- Password-based auth. No hashed-password storage. If operator loses magic-link email access and has no passkey, they use the bearer token to regain access. Design goal: never have a stealable shared credential at rest.
- SSO, SAML, OIDC. Users who want that should layer CF Access in front.
- Role-based access control. Every authenticated user is an admin for v1. Schema keeps a `role` column for future granularity.

## Research anchors

- CF Email Routing `send_email` binding — already in the stack, free, same as alert path. Used for magic-link delivery.
- CF Workers Web Crypto — provides HMAC-SHA256 (session signing), SHA-256 (token hashing), `getRandomValues` (token/session-id generation), `subtle.verify` (passkey signature check). All native, no deps.
- CF D1 — auth state storage. Well under 100k writes/day for typical usage.
- `@simplewebauthn/server` — MIT-licensed, pure-JS, explicitly supports CF Workers. Only new runtime dep. Handles CBOR/COSE parsing + attestation verification.
- `@simplewebauthn/browser` — client-side counterpart, loaded from the dashboard HTML. Also MIT, pure-JS.
- CF Durable Objects NOT used (paid tier only). Rate limiting implemented via D1 queries.

## Design

### Auth flow summary

```
            +-------------+
            |  GET /login |    public login page
            +------+------+
                   |
        +----------+--------------+
        |                         |
        v                         v
 +-------------+         +--------------+
 |  code auth  |         |   passkey    |
 |   (email)   |         |  (WebAuthn)  |
 +------+------+         +------+-------+
        |                       |
  POST /login/email-code   navigator.credentials.get()
  send 6-digit code via    verify via @simplewebauthn/server
  env.EMAIL.send()              |
        |                       |
        v                       v
  POST /login/verify-code  POST /login/passkey
  {email, code}            update counter
  verify hashed code            |
        |                       |
        +----------+------------+
                   |
                   v
          Create session row in D1
          Set HMAC-signed cookie
          Return 302 Location: /
```

Bearer-token path unchanged — break-glass for scripts, first deploy, lockout recovery.

### D1 schema additions (append to `schema.sql`)

```sql
-- Users allowlist. Email is primary key. user_id is a stable opaque UUID used as WebAuthn userHandle.
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,                -- UUID v4, WebAuthn userHandle (stable across email changes)
  added_at INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'admin'
);
CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);

-- Login codes. code_hash is SHA-256 of the 6-digit plaintext; plaintext only in the email body + user's memory.
CREATE TABLE IF NOT EXISTS login_codes (
  code_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,                             -- one-time use
  verify_attempts INTEGER NOT NULL DEFAULT 0   -- limits brute force on the 1M keyspace
);
CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email);
CREATE INDEX IF NOT EXISTS idx_login_codes_expires ON login_codes(expires_at);

-- Active sessions. session_id is random 32 bytes base64url, unique.
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  ip_address TEXT,
  auth_method TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(email);

-- WebAuthn public keys. One row per registered passkey per user.
CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  device_name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  transports TEXT
);
CREATE INDEX IF NOT EXISTS idx_passkeys_email ON passkeys(email);

-- Rate-limit log. Subject-type column prevents email/ip namespace collision.
-- Autoincrement PK avoids same-ms collision on (subject_type, subject_key, ts) tuple.
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL,                  -- 'email' | 'ip'
  subject_key TEXT NOT NULL,                   -- email address OR CF-Connecting-IP value
  ts INTEGER NOT NULL,
  event_type TEXT NOT NULL                     -- 'code_sent' | 'code_verify_fail' | 'code_verify_ok' | 'passkey_fail' | 'passkey_ok'
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_subject_ts ON login_attempts(subject_type, subject_key, ts);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ts ON login_attempts(ts);

-- Durable auth-event audit log (separate from KV events ring; longer retention for forensics).
CREATE TABLE IF NOT EXISTS auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  email TEXT,                                  -- nullable for bearer-break-glass events
  event_type TEXT NOT NULL,                    -- 'login_ok' | 'login_fail' | 'logout' | 'passkey_enrolled' | 'passkey_removed' | 'user_added' | 'user_disabled' | 'user_enabled' | 'user_removed' | 'session_revoked' | 'bearer_break_glass'
  auth_method TEXT,                            -- 'email-code' | 'passkey' | 'bearer-break-glass'
  ip_address TEXT,
  user_agent TEXT,
  metadata TEXT                                -- JSON; actor email for admin actions, etc.
);
CREATE INDEX IF NOT EXISTS idx_auth_events_ts ON auth_events(ts);
CREATE INDEX IF NOT EXISTS idx_auth_events_email_ts ON auth_events(email, ts);

-- Ephemeral WebAuthn challenges (5-min TTL). Keyed by session or temp cookie id.
CREATE TABLE IF NOT EXISTS auth_challenges (
  challenge_id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  purpose TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires ON auth_challenges(expires_at);
```

Schema is additive; existing tables (`domains`, `channels`, `domain_channels`, `config`) unchanged.

### Session cookie format

- Cookie name: `dropwatch_session`
- Value: `<session_id>.<hmac_sig>` where both components are **strict base64url** (no `.` in either half; base64url alphabet is `[A-Za-z0-9_-]`). Enforce via regex validation on parse — reject if value contains anything outside `/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/`.
- `session_id` = `base64url(getRandomValues(new Uint8Array(32)))` → always 43 chars, always URL-safe, never contains `.`
- `hmac_sig` = `base64url(HMAC-SHA256(session_id, SESSION_SECRET))` → always 43 chars
- Split with `.split('.')` then check `parts.length === 2` before processing. Any other cardinality = reject.
- Flags: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=43200` (12 hours)
- On every request:
  1. Parse cookie, verify regex, split into `[session_id, sig]`
  2. Compute expected HMAC; constant-time compare against provided sig; reject on mismatch
  3. Look up `session_id` in D1 `sessions` table; reject if missing, expired, or user disabled
  4. Update `last_used_at` on user (non-blocking via `ctx.waitUntil`)

`SESSION_SECRET` is a 32-byte random value, generated by the bootstrap script alongside `ADMIN_TOKEN` and stored as a CF Worker Secret. Same bootstrap idempotency applies — existence check before generate.

**Dev vs prod:** `wrangler dev` local runs use a throwaway `SESSION_SECRET` from `.dev.vars`. Cookies minted against local will not validate against prod and vice versa. This is correct isolation — called out in README / CONTRIBUTING to avoid confusion.

### Email code flow (no URL redemption, scanner-resistant)

**Why codes not URLs.** URL-based magic links are pre-consumed by corporate mail security scanners (Proofpoint, Microsoft Defender, Mimecast) that auto-click every link in incoming mail to sandbox for malware. One-time tokens get marked "used" by the scanner before the human ever sees the email — auth breaks silently in enterprise environments. 6-digit codes typed back on the login page sidestep this. Pattern used by Slack, Notion, Clerk, Auth0.

1. **`GET /login`** — serves login HTML. Public. Shows:
   - Stage A: Email input + "Send me a sign-in code" button
   - Stage B (after code sent): 6-digit code input + "Verify code" button
   - "Sign in with a passkey" button (separate flow)
   - Collapsed "Break-glass: admin token" section
   - Response headers: `X-Frame-Options: DENY`, CSP includes `frame-ancestors 'none'` (anti-clickjacking)
2. **`POST /login/email-code`** with `{email}`:
   - **Rate-limit pre-check (SELECT before INSERT)** — count rows in `login_attempts` for `(subject_type='email', subject_key=email)` in last 10 min AND `(subject_type='ip', subject_key=<CF-Connecting-IP>)` in last hour. If either is over limit, return `429 Too Many Requests` with `Retry-After`. **No D1 write on rejection** — prevents write-amp DoS.
   - If email is in `users` table AND `disabled=0`:
     - Generate 6-digit `code` via `getRandomValues(new Uint32Array(1))` with rejection sampling (reject values >= 4_294_967_000 to avoid modulo bias, then mod 1_000_000, zero-pad)
     - `code_hash = SHA-256("code=" || code || "|email=" || lowercase(email) || "|secret=" || SESSION_SECRET)` — **domain separators** prevent concatenation collisions (code "1234"+email "5@x" would otherwise collide with code "12345"+email "@x"). Email lowercased before hashing (consistent with how it's stored in `users`).
     - Insert `login_codes` row with `expires_at = now + 600`
     - Queue email via `ctx.waitUntil(env.EMAIL.send(...))`:
       - From: `env.ALERT_FROM_ADDRESS`
       - To: `email`
       - Subject: `domain-drop-watcher sign-in code: <code>` (code in subject for easy preview in most mail clients)
       - Body: `Your 6-digit code: <code>\n\nExpires in 10 minutes. Ignore if you didn't request sign-in. No links to click.`
   - Log `code_sent` to `login_attempts` (both email + IP subject rows) AND `auth_events` (even for non-allowlisted, log event_type='login_fail' with metadata='unknown_email' — useful for forensics).
   - **Regardless** of allowlist membership, return `202 Accepted` with generic body `{ok:true, message:"If your email is registered, a 6-digit code is on its way."}`. Timing matching: the non-allowlisted path performs equivalent D1 work (SELECT + INSERT of `login_attempts` row) and returns with the same shape before `ctx.waitUntil` fires for the real path. **Documented as best-effort enumeration resistance, not constant-time** — network jitter makes pure timing oracles unreliable anyway.
3. **`POST /login/verify-code`** with `{email, code}`:
   - **Origin-header check**: reject if `Origin` header doesn't match the Worker's origin (CSRF mitigation)
   - **Rate-limit check** on email: count `code_verify_fail` attempts last 10 min; ≥5 → reject
   - Compute `code_hash = SHA-256("code=" || code || "|email=" || lowercase(email) || "|secret=" || SESSION_SECRET)`, look up in `login_codes`
   - Reject if not found, `used_at` non-null, `expires_at < now`, or `verify_attempts >= 5` (per-code brute-force cap)
   - On miss, atomic `UPDATE login_codes SET verify_attempts = verify_attempts + 1 WHERE code_hash = ?`; log `code_verify_fail`
   - On hit, atomic `UPDATE login_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL` — if `changes=0`, concurrent redemption → reject
   - Generate `session_id = base64url(getRandomValues(new Uint8Array(32)))` → 43 chars, URL-safe
   - Insert `sessions` row, `auth_method='email-code'`, `user_agent` + `ip_address` from headers
   - Insert `auth_events` row, `event_type='login_ok'`, `auth_method='email-code'`
   - Compute HMAC, set cookie
   - Respond `200 OK` with `{ok: true, redirect: '/'}` — **no GET redirect with token in URL anywhere in the flow**

### Passkey counter handling (corrected per pass-1)

WebAuthn authenticators report an optional monotonic counter. Spec allows authenticators that **always report 0** (legitimate; common for some hardware tokens). Naive "reject if received <= stored" locks these out after first use.

**Correct rule:** reject only when `received < stored`. If `stored == 0 AND received == 0`, accept (counter-less authenticator). If `received > stored`, accept + update. If `received < stored`, reject (possible cloned authenticator; log `auth_event` event_type='passkey_fail' metadata='counter_regression').

### Passkey flow

Uses `@simplewebauthn/server` v10+ API.

**Registration (from an already-logged-in session):**

1. **`POST /passkeys/register/begin`** → `generateRegistrationOptions({ rpName: 'Domain Drop Watcher', rpID: <worker-hostname>, userID: <user_id UUID from users table, NOT email>, userName: email, userDisplayName: email, attestationType: 'none', authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }})` — `userID` is a stable opaque UUID (v4) generated when the user is added to the allowlist, stored in `users.user_id`. Email can change (allowlist remove+re-add with different capitalization, etc.); the UUID never does. This is the correct WebAuthn `userHandle` per the spec.
   - Store the generated `challenge` in `auth_challenges` (keyed by a challenge_id cookie, 5-min expiry)
2. Browser: `@simplewebauthn/browser`'s `startRegistration()` calls `navigator.credentials.create()`
3. **`POST /passkeys/register/finish`** with the attestation response:
   - **Origin-header check** (CSRF): reject if request `Origin` header != Worker origin
   - Retrieve stored challenge via challenge_id cookie
   - Call `verifyRegistrationResponse({ expectedChallenge, expectedOrigin: <worker-origin>, expectedRPID: <worker-hostname> })`. `expectedOrigin` is pinned to the exact deployed origin (no localhost, no wildcards).
   - On success, store `credential_id`, `public_key`, `counter`, `transports` in `passkeys`
   - Log `auth_events` event_type='passkey_enrolled'

**Login:**

1. **`GET /login/passkey/challenge`** → `generateAuthenticationOptions({ rpID: <worker-hostname>, userVerification: 'preferred' })`
   - Browser hits this after user clicks "Sign in with a passkey"
   - Challenge stored in `auth_challenges` keyed by an anonymous temp_id cookie (no session yet)
2. Browser: `startAuthentication()` → `navigator.credentials.get()`
3. **`POST /login/passkey`** with the assertion response:
   - **Origin-header check** (CSRF)
   - Retrieve challenge via temp_id cookie
   - Extract `credential_id` from response, look up `passkeys` row
   - Call `verifyAuthenticationResponse({ authenticator: { credentialID, credentialPublicKey, counter }, expectedChallenge, expectedOrigin, expectedRPID })`
   - On success, apply the **corrected counter rule** above; update `passkeys.counter` to new value, `last_used_at = now`
   - Create session, `auth_method='passkey'`
   - Log `auth_events` event_type='login_ok', auth_method='passkey'

### Rate limiting (D1-backed, no Durable Objects)

**Counts ALL sends, not just failures** (Codex finding #2). Attacker who owns nothing but an email address in the allowlist could otherwise fire unlimited magic emails to that inbox.

Enforced on `POST /login/email-code` (tightened per pass-2: the prior 10/10min still permitted 1,440 sends/day to one inbox, viable mailbomb):

1. **Per-email (short burst)**: count rows where `subject_type='email' AND subject_key=? AND ts > now - 900 AND event_type IN ('code_sent', 'code_verify_fail')`. If count ≥ 3 → reject with `429` + `Retry-After: 900`.
2. **Per-email (daily ceiling)**: count rows same as above but `ts > now - 86400`. If count ≥ 20 → reject with `429` + `Retry-After: 14400` (4h cooldown). Hard ceiling: ~20 magic emails/user/day.
3. **Per-IP**: count rows where `subject_type='ip' AND subject_key=? AND ts > now - 3600`. If count ≥ 50 → reject.

Enforced on `POST /login/verify-code`:

4. **Per-code brute-force cap**: `verify_attempts` column in `login_codes`; reject at ≥5.
5. **Per-email verify-failure cap**: count `code_verify_fail` entries in last 10 min ≥ 5 → reject.

**No D1 write on rate-limit rejection** — the SELECT happens first. If over limit, we 429 without inserting. Prevents free-tier D1 write exhaustion.

**Subject-type column** — `login_attempts` uses separate `subject_type` ('email' | 'ip') + `subject_key` columns.

**Cleanup OUT of request path** (pass-2 Codex blocker): the opportunistic-cleanup DELETE inside request handlers reintroduced write-amp. Moved to a dedicated scheduled cron trigger that runs once every 6 hours:

```sql
-- Runs in scheduled() handler, NOT in fetch() auth routes. No write happens on a failed login attempt.
DELETE FROM login_attempts WHERE rowid IN (SELECT rowid FROM login_attempts WHERE ts < ? LIMIT 5000);
DELETE FROM login_codes WHERE rowid IN (SELECT rowid FROM login_codes WHERE expires_at < ? LIMIT 5000);
DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE expires_at < ? LIMIT 5000);
DELETE FROM auth_challenges WHERE rowid IN (SELECT rowid FROM auth_challenges WHERE expires_at < ? LIMIT 5000);
DELETE FROM auth_events WHERE rowid IN (SELECT rowid FROM auth_events WHERE ts < ? LIMIT 5000);  -- 90-day retention
```

Retention: `login_attempts` and `login_codes` and `sessions` and `auth_challenges` — time-bounded (TTL or expires_at). `auth_events` — 90-day retention (pass-2 finding on unbounded growth; 90 days covers incident investigation + compliance review without letting attacker-driven spam grow D1 indefinitely).

The existing domain-drop-watcher scheduled cron fires every minute. The cleanup runs only when `now % (6 * 3600) < 60` (once per 6h window) — no added cron trigger, fits within the "1 trigger" free-tier slot already in use.

### Auth middleware (unified, replaces current `resolveAdminToken`)

```
async function authenticate(req, env):
  // 1. Session cookie path (preferred)
  cookie = parseCookie(req, 'dropwatch_session')
  if cookie:
    [sid, sig] = cookie.split('.')
    if not constantTimeCompare(sig, hmacSha256(sid, env.SESSION_SECRET)):
      return null
    session = db.query("SELECT * FROM sessions WHERE session_id=? AND expires_at > ?", [sid, now])
    if session and user(session.email).disabled == 0:
      return { email: session.email, method: session.auth_method }

  // 2. Bearer token fallback (break-glass + API scripts)
  authHeader = req.headers.get('Authorization')
  if authHeader.startsWith('Bearer '):
    token = authHeader.slice(7).trim()
    if token and constantTimeCompare(token, env.ADMIN_TOKEN or ''):
      return { email: null, method: 'bearer-break-glass' }

  return null
```

All existing admin routes keep working unchanged — they just get an identified user context instead of "authenticated" boolean.

### User admin routes (new, session-required)

- `GET /users` — list allowlist + active sessions per user
- `POST /users {email}` — add to allowlist
- `DELETE /users/:email` — remove from allowlist + cascade-delete their sessions/tokens/passkeys
- `POST /users/:email/disable` / `POST /users/:email/enable` — toggle disabled flag
- `GET /sessions` — list active sessions (scoped to current user by default, all-users for admin role)
- `DELETE /sessions/:session_id` — revoke specific session
- `POST /sessions/revoke-all` — revoke all sessions for the current user (logout everywhere)
- `POST /users/:email/sessions/revoke-all` — admin-only, revoke all sessions for a specific user
- `POST /logout` — delete current session + clear cookie
- `GET /auth/health` — bearer-gated (break-glass only). Returns `{email_routing_bound: bool, alert_from_set: bool, session_secret_set: bool, admin_token_set: bool, allowlist_size: int, rp_id: string, webauthn_available: bool}`. High-ROI debug endpoint for operators troubleshooting "why isn't my magic code arriving."
- `GET /passkeys` — list passkeys for current user
- `POST /passkeys/register/begin` / `POST /passkeys/register/finish` — enrollment flow
- `DELETE /passkeys/:credential_id` — remove a passkey

### First-user bootstrap (with visibility, addresses pass-1 UX concern)

Unchanged break-glass path, with additional discoverability:

1. Operator deploys, gets `ADMIN_TOKEN` banner in build log (same as today).
2. Operator visits `/login`. **If `users` table is empty**, the login page shows a prominent yellow banner: "No users configured yet. Use your ADMIN_TOKEN below to log in and add the first user." Break-glass section auto-expands when `users` table is empty.
3. Operator pastes `ADMIN_TOKEN` → creates session with `auth_method='bearer-break-glass'`. Log `auth_events` event_type='bearer_break_glass' with IP + UA for forensics.
4. Dashboard shows a persistent "You're signed in via break-glass. Add users at Settings → Users" banner until at least one user is added.
5. Operator adds their email → dashboard banner becomes "You can now sign in via email code or passkey."
6. Operator logs out; logs back in via email code. Enrolls a passkey at Settings → Passkeys for future phishing-resistant login.
7. Optional: operator deletes `ADMIN_TOKEN` Secret via dashboard to retire bearer auth. Docs **strongly recommend keeping it set** for lockout recovery.

### File changes

| File | Change |
|---|---|
| `schema.sql` | Append 6 new CREATE TABLE statements + indexes (all `IF NOT EXISTS`). |
| `wrangler.json` | No change (D1 + EMAIL binding already there). |
| `package.json` | Add runtime dep `@simplewebauthn/server` (latest stable, currently ~v10). `@simplewebauthn/browser` served as a static asset from `public/vendor/` — pinned version, committed to repo (avoids bundler). |
| `public/vendor/simplewebauthn-browser.js` | NEW. `@simplewebauthn/browser` ESM bundle (~10kb). Pinned version; documented manual bump procedure. |
| `scripts/bootstrap-admin-token.mjs` | Extend: also generate `SESSION_SECRET` (32 bytes base64url) if not set. Same idempotency check via `wrangler secret list`. |
| `src/types.ts` | Add `SESSION_SECRET: string` and `WEBAUTHN_RP_ID?: string` (optional override) to `Env`. |
| `src/auth/session.ts` | NEW. `createSession`, `verifySessionCookie`, `revokeSession`, HMAC sign/verify, cookie serialization. |
| `src/auth/magic-link.ts` | NEW. `sendMagicLink`, `verifyMagicLinkToken`. Uses `env.EMAIL.send()`. |
| `src/auth/passkey.ts` | NEW. Thin wrapper over `@simplewebauthn/server`. Challenge storage in `auth_challenges` table. |
| `src/auth/rate-limit.ts` | NEW. `checkLoginRate(db, email, ip)` returns `{allowed, retryAfter}`; writes attempt row. |
| `src/auth/users.ts` | NEW. CRUD helpers for allowlist. |
| `src/admin.ts` | Refactor: `checkAuth` becomes `authenticate` (returns identity or null); add all new `/login`, `/auth`, `/logout`, `/passkeys/*`, `/users/*`, `/sessions/*` routes. Keep bearer-token fallback. |
| `public/index.html` | Major: new login page (email form + passkey button + break-glass), new Settings tabs (Users, Passkeys, Sessions). Import `./vendor/simplewebauthn-browser.js` via `<script type="module">`. |
| `test/auth-magic-link.test.ts` | NEW. ~12 tests: generate, email, verify, session, replay, expired, wrong token, rate limit, enumeration resistance. |
| `test/auth-passkey.test.ts` | NEW. ~8 tests: registration happy path, authentication happy path, counter regression rejection, wrong-origin rejection. Uses `@simplewebauthn/server`'s own test utilities. |
| `test/auth-session.test.ts` | NEW. ~6 tests: HMAC sign/verify, tampered cookie, expired session, revoked session, user-disabled session, cookie parsing edge cases. |
| `test/rate-limit.test.ts` | NEW. ~5 tests: under limit allows, over limit rejects, per-email + global IP, cleanup of old rows. |
| `test/admin.test.ts` | Update: bearer-token path still works; new middleware returns identity object; some existing test fixtures need adjustment for the identity shape. |
| `scripts/smoke.sh` | Add: `POST /login/email` with a non-existent email → expect 202 (enumeration resistance test). |
| `README.md` | New "Multi-user access" section describing magic-link + passkey + user admin + break-glass recovery. Update "Accessing the admin dashboard" to reflect new flow. |
| `SECURITY.md` | Add auth threat model: enumeration resistance, replay prevention, counter regression, session revocation, rate limiting bounds. |
| `IMPLEMENTATION_STATE.md` | Add "Phase 12 — Multi-user auth" section. |

### Configuration

Two new Secrets (both auto-generated by bootstrap, no operator input):

- `SESSION_SECRET` — 32-byte HMAC key for cookie signing. Rotation = delete + redeploy invalidates all sessions.
- (existing) `ADMIN_TOKEN` — break-glass, stays.

One new optional env var:

- `WEBAUTHN_RP_ID` — override auto-detected Relying Party ID. Defaults to the Worker's hostname. Operators using a custom domain set this explicitly.

## Security properties (design summary)

| Concern | Mitigation |
|---|---|
| Allowlist enumeration | `POST /login/email-code` always returns 202 regardless of allowlist membership. Both paths do equivalent synchronous D1 work before responding (SELECT + INSERT into `login_attempts`). Email send deferred via `ctx.waitUntil`. Best-effort, not constant-time. |
| Mail-scanner token pre-consumption | **No URLs in emails**. 6-digit codes typed back on login page. Scanners have nothing to pre-click. |
| Code in email subject line leakage | Subject line visible in push-notification previews on locked phones, logged by SMTP relay headers, indexed by some mail-server search tools. Documented in SECURITY.md as accepted tradeoff for UX (subject preview is the main benefit of having code there). Operators concerned should either use passkeys or disable lock-screen previews. |
| Code replay | Hashed at rest with email+secret salt; one-time-use via atomic UPDATE; 10-min expiry; per-code `verify_attempts` cap at 5. |
| Code brute-force (1M keyspace) | Per-code 5-attempt cap + per-email 5-failures-per-10min rate limit → effective keyspace exploration rate too slow to crack 6 digits before expiry. |
| Session cookie tampering | HMAC-SHA256 with server-held `SESSION_SECRET`. Strict base64url regex on both halves. Constant-time compare. |
| Session replay after logout | Server-side sessions table; DELETE on logout; all requests look up session_id and require not-expired-not-deleted. |
| CSRF | `SameSite=Lax` cookie + **Origin header check on all state-changing POSTs that authenticate via cookie**. **Missing or null `Origin` header is treated as mismatch and rejected.** Routes that authenticate via `Authorization: Bearer` (break-glass bootstrap, `scripts/smoke.sh`) are exempt from the Origin check since they're not cookie-backed and thus not CSRF-exposed. |
| Clickjacking | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` on auth pages (and the main dashboard). |
| XSS stealing session cookie | `HttpOnly` flag. Strict CSP (already documented). |
| Passkey replay | Counter check — reject if `received < stored`. Equal-zero case explicitly allowed for counter-less authenticators. |
| Passkey wrong-origin | `expectedOrigin` check in `@simplewebauthn/server` verification, pinned to the exact deployed origin. No localhost fallback. |
| Passkey user-handle stability | WebAuthn `userID` is a stable UUID in `users.user_id`, not email. Passkey stays bound to the user even if email is removed and re-added. |
| Rate limiting | **3 sends/email/15min burst + 20 sends/email/24h daily ceiling** (counting ALL sends); 50 attempts/IP/hour; 5 verify-fails/code; 5 verify-fails/email/10min. D1-backed, no Durable Objects. SELECT-before-INSERT prevents write-amp DoS. Cleanup DELETEs run in scheduled-cron path, not in auth request handlers. |
| Audit trail | Dedicated `auth_events` D1 table with **90-day retention** (pruned by scheduled cron). Logs logins, failures, enrollments, user admin actions, bearer-break-glass use. |
| Credential stuffing | No passwords exist. Not applicable. |
| Password reset phishing | No passwords to reset. Magic-link is by definition a "reset" each time. |
| Offline brute-force of session secret | HMAC secret never leaves server. 32-byte entropy makes guessing infeasible. |
| Bearer token leak (break-glass) | Operator can rotate via dashboard (same flow as today). Sessions created via bearer-break-glass are logged and revocable. |
| Email compromise | Attacker who controls operator's email gets login — same threat model as any email-based auth including password reset. Mitigation: operator can enroll a passkey and `DELETE FROM users` to remove the email allowlist; passkey then becomes sole login path. |

## Verification

1. **Unit tests** — ~31 new tests across 4 new test files. Must pass alongside all existing tests.
2. **Static checks**:
   - `grep -rn "execSync" src/` — zero matches (enforce execFileSync-only, inherited rule from prior plan)
   - `grep -rn "console.log" src/ --exclude-dir=test` — zero matches (no runtime leakage of sensitive material)
   - `npm run typecheck` — clean
   - `sqlite3 ':memory:' < schema.sql` — clean
3. **Live smoke test** (post-merge, manual via deployed worker):
   - Deploy fresh. Build log has `ADMIN_TOKEN` + (new) `SESSION_SECRET` banners.
   - Visit `/login` with empty allowlist — banner reads "No users configured yet. Use your ADMIN_TOKEN below." Break-glass section auto-expanded.
   - Log in via bearer (break-glass), add self to allowlist, log out.
   - Visit `/login`, type your email → 202 "code on its way" → email arrives with 6-digit code in the subject line
   - Type code in verify form → redirected to dashboard logged in, cookie set
   - Settings → Passkeys → Register — Touch ID / YubiKey prompt — credential stored (confirm `passkeys` row in D1, `auth_events` enrollment entry)
   - Log out, "Sign in with passkey" — biometric prompt — logged in
   - Settings → Sessions — shows current session. Click "Revoke all my sessions" → logged out everywhere, cookie cleared.
   - Add a second user (teammate's email), teammate codes in successfully
   - Disable teammate → teammate's next `/login/email-code` request still returns 202 (enumeration-safe) but no email goes out; verify `auth_events` row with `event_type='login_fail'`
   - Rate-limit burst: request 4 codes for same email within 15 min → 4th returns 429 with `Retry-After: 900`
   - Rate-limit daily ceiling: after burst cooldown passes, accumulate to 20 sends in 24h; 21st returns 429 with `Retry-After: 14400`
4. **Enumeration-resistance timing test**: `POST /login/email-code` with 10 allowlisted + 10 non-existent addresses; compare median response times with `time curl`. Difference should be within network noise (< ~50ms median delta). If systematic, tune implementation.
5. **Counter-regression test**: manually roll back a passkey's `counter` in D1 to 0 then attempt login → expect 401 + `auth_events` entry `event_type='passkey_fail' metadata='counter_regression'`.
6. **Counter-at-zero authenticator test**: enroll a passkey that always reports counter=0 (some hardware tokens). Second login should succeed (not reject).
7. **Brute-force cap test**: request a code for your email, then submit 5 wrong codes → 6th attempt rejected before verify even with correct code (per-code verify_attempts cap).
8. **Origin-header CSRF test**: `curl -X POST /login/verify-code -H 'Origin: https://evil.example' ...` → rejected. Same origin → proceeds.
9. **Clickjacking test**: attempt to embed `/login` in an `<iframe>` from another origin → browser blocks due to `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`.
10. **Mail-scanner-safety test**: visually inspect sent email — confirm NO URLs in body (code only). Regex-check the email body string in the test suite for `https?://` match → fail on presence.
11. **Session revocation test**: log in, grab session cookie, call `POST /logout`, attempt subsequent API call with same cookie → 401.
12. **Bearer break-glass forensic test**: use ADMIN_TOKEN to log in via break-glass → verify `auth_events` entry `event_type='bearer_break_glass'` with ip_address + user_agent populated.

## Revisions from Round 1 review

Both reviewers returned HOLD → GO with overlapping findings. All resolved below.

| Finding | Source | Resolution |
|---|---|---|
| `GET /auth?token=X` pre-consumed by mail scanners | Codex (blocker) | **Replaced URL-based flow with 6-digit code typed by user.** No URL ever in email. |
| Timing side-channel claim hand-waved | Both (blocker) | Equivalent D1 work on both branches (SELECT + INSERT); email send via `ctx.waitUntil` post-response. Documented as best-effort, not constant-time. |
| Rate limiter counts only failures → unlimited sends to a valid email | Codex (blocker) | Now counts ALL sends (`code_sent` event + verify-fails). Lowered IP cap to 50/hr. |
| D1 write-amp DoS | Both (blocker) | SELECT-before-INSERT in `/login/email-code`. No write on rate-limit rejection. |
| Passkey counter=0 lockout | Both (blocker) | Rule corrected to strict `<`; equal-at-zero explicitly allowed. |
| WebAuthn `userID = email` mutable | Codex (blocker) | `user_id` UUID column added to `users` table. Used as WebAuthn userHandle. Email stays as PK for lookup. |
| Session cookie parsing ambiguity | Claude (blocker) | Explicit base64url regex + strict 2-part split. No `.` in either half. |
| CSRF on state-changing POSTs | Claude (blocker) | Origin-header check required on all state-changing POSTs (login-verify, passkey finish, user admin). |
| Audit log in KV ring buffer insufficient | Both (important) | Dedicated `auth_events` D1 table added. Long retention. |
| Revoke-all-sessions missing | Both (important) | `POST /sessions/revoke-all` + admin variant added. |
| IP-key namespace collision | Both (important) | Separate `subject_type` + `subject_key` columns in `login_attempts`. |
| Clickjacking on `/login` | Both (important) | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` on auth pages. |
| Empty-allowlist silent failure UX | Both (important) | Banner on /login when `users` table empty; auto-expand break-glass section; dashboard banner until first user added. |
| Dev vs prod SESSION_SECRET divergence | Claude | Documented in README + CONTRIBUTING. |
| Referer leakage on GET redirect | Claude | No longer applicable — no GET redemption exists. |
| `/auth/health` debug endpoint | Codex Q#5 + Claude | Added to plan, bearer-gated, returns config diagnostic. |

## Open questions for reviewers (post-revision)

1. **Per-code verify-attempts cap** set at 5. Too tight? Operators fat-finger codes too. Reviewer call.
2. **WebAuthn RP-ID migration path**: v1 plan = "enroll passkeys after any custom-domain migration" + UI warning at enrollment time on `*.workers.dev`. Related-origin support (`.well-known/webauthn-origins`) deferred. Accept?
3. **`@simplewebauthn/server` bundle size**: claim 50-100kb gzipped based on package unpacked size ~663kb. Actual Worker bundle depends on tree-shaking (we import a small subset). Verify in implementation CI with a size-budget check; if over 500kb, raise concern before proceeding.
4. **`auth_events` retention**: **RESOLVED — 90-day prune pinned** in scheduled-cron cleanup block. No longer open.
5. **Timing-side-channel residual risk**: even with `ctx.waitUntil`, D1 query planner cache hits can differ between frequent vs never-queried emails. Truly constant-time would require dummy D1 calls on the miss path. Worth the complexity for v1, or accept best-effort?

## Implementation sequencing (after plan approval)

Serial phases (auth is high-consequence, no parallel work):

1. Schema additions + bootstrap script update (adds `SESSION_SECRET` generation)
2. Session module (`src/auth/session.ts`) + tests
3. Magic-link module + tests
4. Rate-limit module + tests
5. Users CRUD module + tests
6. Integrate into `src/admin.ts` routing (new middleware + new routes), update existing admin test fixtures
7. Passkey module + tests (pulls in `@simplewebauthn/server`)
8. Dashboard HTML rewrite (login page, Settings tabs)
9. README + SECURITY.md + IMPLEMENTATION_STATE.md
10. Self-verify (typecheck, tests, grep gates)
11. Single commit to main, push
12. Live smoke test per Verification section 3
