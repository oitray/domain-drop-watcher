import { describe, it, expect, beforeEach } from "vitest";
import { handleAdmin } from "../src/admin.js";
import type { Env } from "../src/types.js";
import type { D1Database, KVNamespace } from "@cloudflare/workers-types";

// ---------------------------------------------------------------------------
// In-memory D1 mock
// ---------------------------------------------------------------------------

interface Row {
  [key: string]: unknown;
}

type TableName = "domains" | "channels" | "domain_channels" | "config";

function makeD1(seed?: { [table in TableName]?: Row[] }): D1Database {
  const tables: { [table in TableName]: Row[] } = {
    domains: seed?.domains ?? [],
    channels: seed?.channels ?? [],
    domain_channels: seed?.domain_channels ?? [],
    config: seed?.config ?? [],
  };

  function matchTable(sql: string): TableName | null {
    const lower = sql.toLowerCase();
    if (lower.includes("from domains") || lower.includes("into domains") || lower.includes("update domains") || lower.includes("delete from domains")) return "domains";
    if (lower.includes("from channels") || lower.includes("into channels") || lower.includes("update channels") || lower.includes("delete from channels")) return "channels";
    if (lower.includes("from domain_channels") || lower.includes("into domain_channels") || lower.includes("delete from domain_channels")) return "domain_channels";
    if (lower.includes("from config") || lower.includes("into config") || lower.includes("update config")) return "config";
    return null;
  }

  function executeSQL(sql: string, bindings: unknown[]): { results: Row[]; changes: number; last_row_id: number } {
    const lower = sql.toLowerCase().trim();
    const table = matchTable(sql);

    // SELECT queries
    if (lower.startsWith("select")) {
      if (!table) return { results: [], changes: 0, last_row_id: 0 };

      let rows = [...tables[table]];

      // Handle WHERE conditions (simplified for our use case)
      if (lower.includes("where")) {
        // fqdn = ?
        const fqdnMatch = /where\s+(?:dc\.)?fqdn\s*=\s*\?/.exec(lower);
        if (fqdnMatch) {
          const val = bindings[0] as string;
          rows = rows.filter((r) => r["fqdn"] === val);
          bindings = bindings.slice(1);
        }
        // channel_id = ?
        const chIdMatch = /where\s+channel_id\s*=\s*\?/.exec(lower);
        if (chIdMatch) {
          const val = bindings[0] as string;
          rows = rows.filter((r) => r["channel_id"] === val);
          bindings = bindings.slice(1);
        }
        // id = ?
        const idMatch = /where\s+(?:c\.)?id\s*=\s*\?/.exec(lower);
        if (idMatch) {
          const val = bindings[0] as string;
          rows = rows.filter((r) => r["id"] === val);
          bindings = bindings.slice(1);
        }
        // k = ?
        const kMatch = /where\s+k\s*=\s*\?/.exec(lower);
        if (kMatch) {
          const val = bindings[0] as string;
          rows = rows.filter((r) => r["k"] === val);
          bindings = bindings.slice(1);
        }
        // paused = 0 AND tld_supported = 1
        if (lower.includes("paused = 0")) {
          rows = rows.filter((r) => r["paused"] === 0);
        }
        if (lower.includes("tld_supported = 1")) {
          rows = rows.filter((r) => r["tld_supported"] === 1);
        }
        // next_due_at <= ?
        if (lower.includes("next_due_at <=")) {
          const val = bindings[0] as number;
          rows = rows.filter((r) => (r["next_due_at"] as number) <= val);
          bindings = bindings.slice(1);
        }
        // dc join
        if (lower.includes("join domain_channels dc")) {
          const dcRows = tables["domain_channels"];
          rows = rows.filter((ch) => dcRows.some((dc) => dc["channel_id"] === ch["id"] && dc["fqdn"] === bindings[0]));
        }
      }

      // LIMIT
      const limitMatch = /limit\s+(\d+)/.exec(lower);
      if (limitMatch) {
        const lim = parseInt(limitMatch[1] ?? "0", 10);
        rows = rows.slice(0, lim);
      }

      return { results: rows, changes: 0, last_row_id: 0 };
    }

    // INSERT
    if (lower.startsWith("insert")) {
      if (!table) return { results: [], changes: 0, last_row_id: 0 };

      // INSERT INTO config ... ON CONFLICT
      if (table === "config" && lower.includes("on conflict")) {
        const k = bindings[0] as string;
        const v = bindings[1] as string;
        const idx = tables.config.findIndex((r) => r["k"] === k);
        if (idx >= 0) {
          tables.config[idx] = { k, v };
        } else {
          tables.config.push({ k, v });
        }
        return { results: [], changes: 1, last_row_id: 0 };
      }

      // INSERT OR IGNORE INTO domain_channels
      if (table === "domain_channels") {
        const fqdn = bindings[0] as string;
        const channel_id = bindings[1] as string;
        const exists = tables.domain_channels.some((r) => r["fqdn"] === fqdn && r["channel_id"] === channel_id);
        if (!exists) {
          tables.domain_channels.push({ fqdn, channel_id });
          return { results: [], changes: 1, last_row_id: 0 };
        }
        return { results: [], changes: 0, last_row_id: 0 };
      }

      // INSERT INTO channels
      if (table === "channels") {
        const row: Row = {
          id: bindings[0],
          type: bindings[1],
          target: bindings[2],
          label: bindings[3] ?? null,
          disabled: bindings[4] ?? 0,
          last_delivery_result: null,
          last_delivery_at: null,
        };
        tables.channels.push(row);
        return { results: [], changes: 1, last_row_id: 0 };
      }

      // INSERT INTO domains with CTE budget check
      if (table === "domains" && lower.includes("with minutes")) {
        // Extract proposed cadence_minutes and phase_offset for the budget CTE
        // Binding order from upsertDomainWithBudgetCheck:
        // fqdn, cadence_minutes, phase_offset_minutes, next_due_at, paused, notify_on, label, tld_supported,
        // lcmWindow-1, cadence_minutes, phase_offset_minutes, subreqLimit
        const fqdn = bindings[0] as string;
        const cadence_minutes = bindings[1] as number;
        const phase_offset_minutes = bindings[2] as number;
        const next_due_at = bindings[3] as number;
        const paused = bindings[4] as number;
        const notify_on = bindings[5] as string;
        const label = bindings[6] as string | null;
        const tld_supported = bindings[7] as number;
        // bindings[8] = lcmWindow-1, bindings[9] = cadence, bindings[10] = offset, bindings[11] = limit
        const subreqLimit = bindings[11] as number;

        // Compute peak inline (mirrors CTE logic)
        const active = tables.domains
          .filter((d) => d["paused"] === 0)
          .map((d) => ({ cadence: d["cadence_minutes"] as number, offset: d["phase_offset_minutes"] as number }));
        active.push({ cadence: cadence_minutes, offset: phase_offset_minutes });

        let peak = 0;
        for (let m = 0; m < 1440; m++) {
          let cnt = 0;
          for (const d of active) {
            if (m % d.cadence === d.offset) cnt++;
          }
          if (cnt > peak) peak = cnt;
        }

        if (peak > subreqLimit) {
          return { results: [], changes: 0, last_row_id: 0 };
        }

        const existing = tables.domains.findIndex((d) => d["fqdn"] === fqdn);
        const row: Row = {
          fqdn, added_at: Math.floor(Date.now() / 1000), cadence_minutes, phase_offset_minutes,
          next_due_at, paused, notify_on, label, tld_supported,
          last_status: null, last_status_changed_at: null, last_checked_at: null,
          pending_confirm_status: null, pending_confirm_count: 0,
        };
        if (existing >= 0) {
          tables.domains[existing] = row;
        } else {
          tables.domains.push(row);
        }
        return { results: [], changes: 1, last_row_id: 0 };
      }

      return { results: [], changes: 0, last_row_id: 0 };
    }

    // UPDATE
    if (lower.startsWith("update")) {
      if (!table) return { results: [], changes: 0, last_row_id: 0 };

      if (table === "domains") {
        // UPDATE domains SET last_checked_at = ? WHERE fqdn = ?
        if (lower.includes("last_checked_at")) {
          const val = bindings[0] as number;
          const fqdn = bindings[1] as string;
          tables.domains.forEach((r) => { if (r["fqdn"] === fqdn) r["last_checked_at"] = val; });
          return { results: [], changes: 1, last_row_id: 0 };
        }
        // UPDATE domains SET cadence_minutes = ?, phase_offset_minutes = ? WHERE fqdn = ?
        if (lower.includes("phase_offset_minutes")) {
          const cadence = bindings[0] as number;
          const offset = bindings[1] as number;
          const fqdn = bindings[2] as string;
          tables.domains.forEach((r) => {
            if (r["fqdn"] === fqdn) { r["cadence_minutes"] = cadence; r["phase_offset_minutes"] = offset; }
          });
          return { results: [], changes: 1, last_row_id: 0 };
        }
        // Generic SET ... WHERE fqdn = ?
        const fqdn = bindings[bindings.length - 1] as string;
        const setMatch = /set\s+(.+?)\s+where/.exec(lower);
        if (setMatch) {
          const setParts = setMatch[1]!.split(",").map((s) => s.trim().split(/\s*=\s*/)[0]?.trim());
          tables.domains.forEach((r) => {
            if (r["fqdn"] !== fqdn) return;
            setParts.forEach((col, i) => {
              if (col) r[col] = bindings[i] ?? null;
            });
          });
        }
        return { results: [], changes: 1, last_row_id: 0 };
      }

      if (table === "channels") {
        const id = bindings[bindings.length - 1] as string;
        const setMatch = /set\s+(.+?)\s+where/.exec(lower);
        if (setMatch) {
          const setParts = setMatch[1]!.split(",").map((s) => s.trim().split(/\s*=\s*/)[0]?.trim());
          tables.channels.forEach((r) => {
            if (r["id"] !== id) return;
            setParts.forEach((col, i) => {
              if (col) r[col] = bindings[i] ?? null;
            });
          });
        }
        return { results: [], changes: 1, last_row_id: 0 };
      }

      return { results: [], changes: 0, last_row_id: 0 };
    }

    // DELETE
    if (lower.startsWith("delete")) {
      if (!table) return { results: [], changes: 0, last_row_id: 0 };

      if (table === "domains") {
        const fqdn = bindings[0] as string;
        const before = tables.domains.length;
        tables.domains = tables.domains.filter((r) => r["fqdn"] !== fqdn);
        const removed = before - tables.domains.length;
        if (removed > 0) {
          tables.domain_channels = tables.domain_channels.filter((r) => r["fqdn"] !== fqdn);
        }
        return { results: [], changes: removed, last_row_id: 0 };
      }

      if (table === "channels") {
        const id = bindings[0] as string;
        const before = tables.channels.length;
        tables.channels = tables.channels.filter((r) => r["id"] !== id);
        return { results: [], changes: before - tables.channels.length, last_row_id: 0 };
      }

      if (table === "domain_channels") {
        if (lower.includes("fqdn = ? and channel_id = ?")) {
          const fqdn = bindings[0] as string;
          const chId = bindings[1] as string;
          const before = tables.domain_channels.length;
          tables.domain_channels = tables.domain_channels.filter(
            (r) => !(r["fqdn"] === fqdn && r["channel_id"] === chId),
          );
          return { results: [], changes: before - tables.domain_channels.length, last_row_id: 0 };
        }
        const chId = bindings[0] as string;
        const before = tables.domain_channels.length;
        tables.domain_channels = tables.domain_channels.filter((r) => r["channel_id"] !== chId);
        return { results: [], changes: before - tables.domain_channels.length, last_row_id: 0 };
      }

      return { results: [], changes: 0, last_row_id: 0 };
    }

    return { results: [], changes: 0, last_row_id: 0 };
  }

  function makeStmt(sql: string, bindings: unknown[]): ReturnType<D1Database["prepare"]> {
    const stmt = {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        const res = executeSQL(sql, bindings);
        return {
          success: true,
          results: res.results,
          meta: { changes: res.changes, last_row_id: res.last_row_id, duration: 0, rows_read: 0, rows_written: 0, size_after: 0, changed_db: false },
        };
      },
      first: async <T = unknown>() => {
        const res = executeSQL(sql, bindings);
        return (res.results[0] ?? null) as T | null;
      },
      all: async <T = unknown>() => {
        const res = executeSQL(sql, bindings);
        return {
          success: true,
          results: res.results as T[],
          meta: { changes: res.changes, last_row_id: res.last_row_id, duration: 0, rows_read: 0, rows_written: 0, size_after: 0, changed_db: false },
        };
      },
      raw: async <T = unknown>() => {
        const res = executeSQL(sql, bindings);
        return res.results.map((r) => Object.values(r)) as T[];
      },
    };
    return stmt as unknown as ReturnType<D1Database["prepare"]>;
  }

  return {
    prepare: (sql: string) => makeStmt(sql, []),
    dump: () => Promise.resolve(new ArrayBuffer(0)),
    batch: async (stmts: ReturnType<D1Database["prepare"]>[]) => {
      return Promise.all(stmts.map((s) => (s as unknown as { run: () => Promise<unknown> }).run()));
    },
    exec: () => Promise.resolve({ count: 0, duration: 0 }),
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// KV mock (ring buffer only)
// ---------------------------------------------------------------------------

function makeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string, type?: string) => {
      const val = store.get(key) ?? null;
      if (type === "json" && val) return JSON.parse(val) as unknown;
      return val;
    },
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// Env factory
// ---------------------------------------------------------------------------

function makeEnv(dbSeed?: { [table in "domains" | "channels" | "domain_channels" | "config"]?: Row[] }): Env {
  return {
    DB: makeD1(dbSeed),
    EVENTS: makeKV(),
    BOOTSTRAP: makeKV(),
    ADMIN_TOKEN: "correct-token",
    WEBHOOK_HOST_ALLOWLIST_DEFAULT: "*.webhook.office.com,hooks.slack.com,discord.com,discordapp.com",
    VERSION: "0.1.0-test",
  };
}

function authReq(path: string, opts?: RequestInit): Request {
  return new Request(`https://example.workers.dev${path}`, {
    ...opts,
    headers: { "Authorization": "Bearer correct-token", "content-type": "application/json", ...(opts?.headers ?? {}) },
  });
}

function noAuthReq(path: string, opts?: RequestInit): Request {
  return new Request(`https://example.workers.dev${path}`, opts);
}

const NOOP_CTX = {} as ExecutionContext;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/health — unauthenticated", () => {
  it("returns 200 + {ok:true} without auth", async () => {
    const env = makeEnv();
    const res = await handleAdmin(noAuthReq("/health"), env, NOOP_CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
  });
});

describe("auth middleware", () => {
  it("returns 401 when Authorization header is absent", async () => {
    const env = makeEnv();
    const res = await handleAdmin(noAuthReq("/domains"), env, NOOP_CTX);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("returns 401 when token is wrong", async () => {
    const env = makeEnv();
    const res = await handleAdmin(
      new Request("https://example.workers.dev/domains", {
        headers: { "Authorization": "Bearer wrong-token" },
      }),
      env,
      NOOP_CTX,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong token on non-domain route", async () => {
    const env = makeEnv();
    const res = await handleAdmin(
      new Request("https://example.workers.dev/budget", {
        headers: { "Authorization": "Bearer bad" },
      }),
      env,
      NOOP_CTX,
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /domains", () => {
  it("returns 200 + empty array initially", async () => {
    const env = makeEnv();
    const res = await handleAdmin(authReq("/domains"), env, NOOP_CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  it("returns domain list when seeded", async () => {
    const env = makeEnv({
      domains: [{
        fqdn: "example.com", added_at: 1, cadence_minutes: 5, phase_offset_minutes: 0,
        next_due_at: 2, paused: 0, notify_on: '["available"]', label: null, tld_supported: 1,
        last_status: null, last_status_changed_at: null, last_checked_at: null,
        pending_confirm_status: null, pending_confirm_count: 0,
      }],
    });
    const res = await handleAdmin(authReq("/domains"), env, NOOP_CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ fqdn: string }>;
    expect(body.length).toBe(1);
    expect(body[0]?.fqdn).toBe("example.com");
  });
});

describe("POST /domains — valid", () => {
  it("returns 201 + domain with phase_offset_minutes populated", async () => {
    const env = makeEnv();
    const res = await handleAdmin(
      authReq("/domains", {
        method: "POST",
        body: JSON.stringify({ fqdn: "test-drop.com", cadenceMinutes: 5, notifyOn: ["available"] }),
      }),
      env,
      NOOP_CTX,
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { fqdn: string; phase_offset_minutes: number };
    expect(body.fqdn).toBe("test-drop.com");
    expect(typeof body.phase_offset_minutes).toBe("number");
  });

  it("lowercases fqdn before storing", async () => {
    const env = makeEnv();
    const res = await handleAdmin(
      authReq("/domains", {
        method: "POST",
        body: JSON.stringify({ fqdn: "UPPER.COM" }),
      }),
      env,
      NOOP_CTX,
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { fqdn: string };
    expect(body.fqdn).toBe("upper.com");
  });
});

describe("POST /domains — validation", () => {
  it("returns 400 for missing fqdn", async () => {
    const env = makeEnv();
    const res = await handleAdmin(
      authReq("/domains", { method: "POST", body: JSON.stringify({ cadenceMinutes: 5 }) }),
      env,
      NOOP_CTX,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("validation_failed");
  });

  it("returns 400 for invalid fqdn format", async () => {
    const env = makeEnv();
    const res = await handleAdmin(
      authReq("/domains", { method: "POST", body: JSON.stringify({ fqdn: "not a domain!" }) }),
      env,
      NOOP_CTX,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for cadenceMinutes out of range", async () => {
    const env = makeEnv();
    const res = await handleAdmin(
      authReq("/domains", { method: "POST", body: JSON.stringify({ fqdn: "test.com", cadenceMinutes: 9999 }) }),
      env,
      NOOP_CTX,
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /domains — over budget", () => {
  it("returns 400 with error:'budget_exceeded' when 45 1-min domains already exist", async () => {
    const existingDomains = Array.from({ length: 45 }, (_, i) => ({
      fqdn: `domain-${i}.com`,
      added_at: 1,
      cadence_minutes: 1,
      phase_offset_minutes: 0,
      next_due_at: 1,
      paused: 0,
      notify_on: '["available"]',
      label: null,
      tld_supported: 1,
      last_status: null,
      last_status_changed_at: null,
      last_checked_at: null,
      pending_confirm_status: null,
      pending_confirm_count: 0,
    }));
    const env = makeEnv({ domains: existingDomains });

    const res = await handleAdmin(
      authReq("/domains", {
        method: "POST",
        body: JSON.stringify({ fqdn: "newdomain.com", cadenceMinutes: 1 }),
      }),
      env,
      NOOP_CTX,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("budget_exceeded");
  });
});

describe("POST /domains/bulk", () => {
  it("dryRun:true returns accepted/rejected without persisting", async () => {
    const env = makeEnv();
    const res = await handleAdmin(
      authReq("/domains/bulk", {
        method: "POST",
        body: JSON.stringify({
          dryRun: true,
          domains: [
            { fqdn: "valid.com" },
            { fqdn: "also-valid.com" },
            { fqdn: "!invalid" },
          ],
        }),
      }),
      env,
      NOOP_CTX,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: unknown[]; rejected: unknown[]; dryRun: boolean };
    expect(body.dryRun).toBe(true);
    expect(body.accepted.length).toBe(2);
    expect(body.rejected.length).toBe(1);

    // verify nothing was persisted
    const listRes = await handleAdmin(authReq("/domains"), env, NOOP_CTX);
    const list = await listRes.json() as unknown[];
    expect(list.length).toBe(0);
  });

  it("without dryRun persists valid domains", async () => {
    const env = makeEnv();
    const res = await handleAdmin(
      authReq("/domains/bulk", {
        method: "POST",
        body: JSON.stringify({
          domains: [{ fqdn: "a.com" }, { fqdn: "b.com" }],
        }),
      }),
      env,
      NOOP_CTX,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: unknown[] };
    expect(body.accepted.length).toBe(2);
  });
});

describe("GET /channels", () => {
  it("returns empty array initially", async () => {
    const env = makeEnv();
    const res = await handleAdmin(authReq("/channels"), env, NOOP_CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });
});

describe("POST /channels — webhook allowed", () => {
  it("returns 201 for Teams webhook on allowed host", async () => {
    const env = makeEnv();
    const res = await handleAdmin(
      authReq("/channels", {
        method: "POST",
        body: JSON.stringify({
          type: "webhook-teams",
          target: "https://myorg.webhook.office.com/webhookb2/test",
          label: "Teams alerts",
        }),
      }),
      env,
      NOOP_CTX,
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; type: string };
    expect(typeof body.id).toBe("string");
    expect(body.type).toBe("webhook-teams");
  });
});

describe("POST /channels — webhook disallowed", () => {
  it("returns 400 with validation_failed for disallowed webhook host", async () => {
    const env = makeEnv();
    const res = await handleAdmin(
      authReq("/channels", {
        method: "POST",
        body: JSON.stringify({
          type: "webhook-generic",
          target: "https://evil.notallowed.example.com/hook",
          label: "Bad webhook",
        }),
      }),
      env,
      NOOP_CTX,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("validation_failed");
  });
});

describe("DELETE /channels/:id — channel in use", () => {
  it("returns 409 channel_in_use when domain references it without force", async () => {
    const channelId = "ch-abc-123";
    const env = makeEnv({
      channels: [{
        id: channelId, type: "webhook-teams",
        target: "https://myorg.webhook.office.com/test", label: null, disabled: 0,
        last_delivery_result: null, last_delivery_at: null,
      }],
      domain_channels: [{ fqdn: "test.com", channel_id: channelId }],
    });

    const res = await handleAdmin(
      authReq(`/channels/${channelId}`, { method: "DELETE" }),
      env,
      NOOP_CTX,
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; domains: string[] };
    expect(body.error).toBe("channel_in_use");
    expect(body.domains).toContain("test.com");
  });

  it("deletes with ?force=true even when referenced", async () => {
    const channelId = "ch-force-del";
    const env = makeEnv({
      channels: [{
        id: channelId, type: "webhook-slack",
        target: "https://hooks.slack.com/services/T/B/x", label: null, disabled: 0,
        last_delivery_result: null, last_delivery_at: null,
      }],
      domain_channels: [{ fqdn: "test.com", channel_id: channelId }],
    });

    const res = await handleAdmin(
      authReq(`/channels/${channelId}?force=true`, { method: "DELETE" }),
      env,
      NOOP_CTX,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: boolean };
    expect(body.deleted).toBe(true);
  });
});

describe("GET /budget", () => {
  it("returns 200 with BudgetReport shape", async () => {
    const env = makeEnv();
    const res = await handleAdmin(authReq("/budget"), env, NOOP_CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      peakDuePerMinute: number;
      checksPerDay: number;
      withinFreeTier: boolean;
      warnings: unknown[];
      headroom: number;
    };
    expect(typeof body.peakDuePerMinute).toBe("number");
    expect(typeof body.checksPerDay).toBe("number");
    expect(typeof body.withinFreeTier).toBe("boolean");
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(typeof body.headroom).toBe("number");
  });

  it("withinFreeTier is true for empty domain list", async () => {
    const env = makeEnv();
    const res = await handleAdmin(authReq("/budget"), env, NOOP_CTX);
    const body = await res.json() as { withinFreeTier: boolean; headroom: number };
    expect(body.withinFreeTier).toBe(true);
    expect(body.headroom).toBe(45);
  });
});

describe("GET /events", () => {
  it("returns 200 with empty array when no events", async () => {
    const env = makeEnv();
    const res = await handleAdmin(authReq("/events"), env, NOOP_CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });
});

describe("GET /", () => {
  it("returns phase 7 placeholder text", async () => {
    const env = makeEnv();
    const res = await handleAdmin(noAuthReq("/"), env, NOOP_CTX);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("dashboard coming in phase 7");
  });
});

describe("security headers", () => {
  it("JSON responses have X-Content-Type-Options: nosniff", async () => {
    const env = makeEnv();
    const res = await handleAdmin(noAuthReq("/health"), env, NOOP_CTX);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("/ response has CSP header", async () => {
    const env = makeEnv();
    const res = await handleAdmin(noAuthReq("/"), env, NOOP_CTX);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src");
  });
});
