import { describe, it, expect, vi } from 'vitest';
import { handleAdmin } from '../src/admin.js';
import type { Env } from '../src/types.js';

const BASE64URL_RE = /[A-Za-z0-9\-_]{43}/;

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
          const isInsertToken =
            sql.includes("INSERT INTO config") &&
            sql.includes("runtime_admin_token") &&
            sql.includes("DO NOTHING") &&
            boundArgs.length > 0;
          if (isInsertToken) {
            if ('runtime_admin_token' in configStore) {
              return { results: [], success: true, meta: { changes: 0 } } as unknown as D1Result;
            }
            configStore['runtime_admin_token'] = boundArgs[0] as string;
            return { results: [], success: true, meta: { changes: 1 } } as unknown as D1Result;
          }
          return { results: [], success: true, meta: { changes: 0 } } as unknown as D1Result;
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
  it('first visit with no D1 row returns 200 with base64url 43-char token in HTML', async () => {
    const env = makeEnv();
    const res = await handleAdmin(setupRequest(), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.text();
    const match = BASE64URL_RE.exec(body);
    expect(match).not.toBeNull();
  });

  it('token is persisted to D1 config table on first visit', async () => {
    const configStore: Record<string, string> = {};
    const env = makeEnv({ DB: makeDb(configStore) });
    const res = await handleAdmin(setupRequest(), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.text();
    const match = BASE64URL_RE.exec(body);
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

  it('concurrent /setup race — first caller wins, second gets 403', async () => {
    const configStore: Record<string, string> = {};
    const db = makeDb(configStore);
    const env1 = makeEnv({ DB: db });
    const env2 = makeEnv({ DB: db });

    const [res1, res2] = await Promise.all([
      handleAdmin(setupRequest(), env1, {} as ExecutionContext),
      handleAdmin(setupRequest(), env2, {} as ExecutionContext),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 403]);

    const winner = res1.status === 200 ? res1 : res2;
    const winnerBody = await winner.text();
    const match = BASE64URL_RE.exec(winnerBody);
    expect(match).not.toBeNull();
  });

  it('console.log fires with the bootstrap token on the winning request', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const configStore: Record<string, string> = {};
      const env = makeEnv({ DB: makeDb(configStore) });
      const res = await handleAdmin(setupRequest(), env, {} as ExecutionContext);
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledOnce();
      const logArg = spy.mock.calls[0]![0] as string;
      expect(logArg).toContain('[domain-drop-watcher] Bootstrap admin token:');
      const token = configStore['runtime_admin_token'];
      expect(logArg).toContain(token);
    } finally {
      spy.mockRestore();
    }
  });

  it('console.log does NOT fire when setup is already complete', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const configStore: Record<string, string> = { runtime_admin_token: 'existing-token' };
      const env = makeEnv({ DB: makeDb(configStore) });
      const res = await handleAdmin(setupRequest(), env, {} as ExecutionContext);
      expect(res.status).toBe(403);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
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
