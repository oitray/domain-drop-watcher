import { describe, it, expect } from 'vitest';
import { handleAdmin } from '../src/admin.js';
import type { Env } from '../src/types.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function makeDb(configStore: Record<string, string> = {}): D1Database {
  return {
    prepare(sql: string) {
      let boundArgs: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          boundArgs = args;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('WHERE k = ?')) {
            const v = configStore['runtime_admin_token'];
            return v !== undefined ? ({ v } as unknown as T) : null;
          }
          return null;
        },
        async run() {
          if (
            sql.includes("INSERT INTO config") &&
            sql.includes("runtime_admin_token") &&
            boundArgs.length > 0
          ) {
            configStore['runtime_admin_token'] = boundArgs[0] as string;
          }
          return { results: [], success: true, meta: {} as D1Meta };
        },
        async all<T>() {
          return { results: [] as T[], success: true, meta: {} as D1Meta };
        },
      };
      return stmt;
    },
    batch: async () => [],
    dump: async () => new ArrayBuffer(0),
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as D1Database;
}

function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
    async list() { return { keys: [], list_complete: true, caret: undefined }; },
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: makeDb(),
    EVENTS: makeKv(),
    BOOTSTRAP: makeKv(),
    WEBHOOK_HOST_ALLOWLIST_DEFAULT:
      '*.webhook.office.com,hooks.slack.com,discord.com,discordapp.com',
    ...overrides,
  };
}

function setupRequest(): Request {
  return new Request('https://example.workers.dev/setup', { method: 'GET' });
}

describe('GET /setup bootstrap', () => {
  it('first visit with no D1 row and no env ADMIN_TOKEN returns 200 with UUID in HTML', async () => {
    const env = makeEnv();
    const res = await handleAdmin(setupRequest(), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.text();
    const match = UUID_RE.exec(body);
    expect(match).not.toBeNull();
  });

  it('token is persisted to D1 config table on first visit', async () => {
    const configStore: Record<string, string> = {};
    const env = makeEnv({ DB: makeDb(configStore) });
    const res = await handleAdmin(setupRequest(), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.text();
    const match = UUID_RE.exec(body);
    expect(match).not.toBeNull();
    const tokenInHtml = match![0];
    expect(configStore['runtime_admin_token']).toBe(tokenInHtml);
  });

  it('second visit returns 403', async () => {
    const configStore: Record<string, string> = { runtime_admin_token: 'already-set-token' };
    const env = makeEnv({ DB: makeDb(configStore) });
    const res = await handleAdmin(setupRequest(), env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it('returns 403 immediately when env.ADMIN_TOKEN is set', async () => {
    const env = makeEnv({ ADMIN_TOKEN: 'env-provided-token' });
    const res = await handleAdmin(setupRequest(), env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it('admin auth middleware picks up D1 token when env.ADMIN_TOKEN is unset', async () => {
    const stored = 'd1-stored-token-xyz';
    const configStore: Record<string, string> = { runtime_admin_token: stored };
    const env = makeEnv({ DB: makeDb(configStore) });
    const req = new Request('https://example.workers.dev/health', {
      headers: { Authorization: `Bearer ${stored}` },
    });
    const res = await handleAdmin(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('admin auth returns 401 when D1 token does not match', async () => {
    const configStore: Record<string, string> = { runtime_admin_token: 'correct-token' };
    const env = makeEnv({ DB: makeDb(configStore) });
    const req = new Request('https://example.workers.dev/domains', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    const res = await handleAdmin(req, env, {} as ExecutionContext);
    expect(res.status).toBe(401);
  });
});
