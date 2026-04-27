import type { Env } from "./types.js";
import { handleAdmin } from "./admin.js";
import { getConfig, getDueDomains, recordCheckBatch, getChannelsForDomain } from "./db.js";
import { appendEvent, markAlertSeen } from "./kv.js";
import { lookupDomain } from "./rdap.js";
import { dispatchAlert } from "./alerts.js";

export async function runDemoReset(db: D1Database): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare("DELETE FROM domain_channels"),
    db.prepare("DELETE FROM domains"),
    db.prepare("DELETE FROM channels"),
    db.prepare("DELETE FROM auth_events WHERE event_type != 'demo_reset'"),
    db.prepare("INSERT INTO auth_events (ts, event_type, metadata) VALUES (?, 'demo_reset', '{}')").bind(now),
    db.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('last_demo_reset', ?)").bind(String(now)),
  ]);
}

const ALERTABLE_STATUSES = new Set(["available", "dropping"]);

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleAdmin(req, env, ctx);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "internal", message: String(err) }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    if ((await getConfig(env.DB, "global_paused")) === "1") return;

    const now = Math.floor(Date.now() / 1000);

    // Auth cleanup runs once per 6h window. Cron fires every minute, so the
    // modulo check fires in the first minute of each 6h window exactly once.
    if (now % (6 * 3600) < 60) {
      const cutoffShort = now - 86_400;        // login_attempts / login_codes: 24h
      const cutoffSession = now;               // sessions: expires_at already encodes TTL
      const cutoffChallenge = now;             // auth_challenges: expires_at
      const cutoffEvents = now - 90 * 86_400; // auth_events: 90-day retention
      ctx.waitUntil(
        (async () => {
          await env.DB.prepare(
            "DELETE FROM login_attempts WHERE rowid IN (SELECT rowid FROM login_attempts WHERE ts < ? LIMIT 5000)",
          ).bind(cutoffShort).run();
          await env.DB.prepare(
            "DELETE FROM login_codes WHERE rowid IN (SELECT rowid FROM login_codes WHERE expires_at < ? LIMIT 5000)",
          ).bind(cutoffSession).run();
          await env.DB.prepare(
            "DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE expires_at < ? LIMIT 5000)",
          ).bind(cutoffSession).run();
          await env.DB.prepare(
            "DELETE FROM auth_challenges WHERE rowid IN (SELECT rowid FROM auth_challenges WHERE expires_at < ? LIMIT 5000)",
          ).bind(cutoffChallenge).run();
          await env.DB.prepare(
            "DELETE FROM auth_events WHERE rowid IN (SELECT rowid FROM auth_events WHERE ts < ? LIMIT 5000)",
          ).bind(cutoffEvents).run();
        })(),
      );
    }

    // Daily demo reset at 04:00 UTC. Fires once per day max, idempotent across restarts.
    if (env.DEMO_MODE === "1" && new Date(now * 1000).getUTCHours() === 4) {
      const lastResetRow = await env.DB
        .prepare("SELECT v FROM config WHERE k = 'last_demo_reset'")
        .first<{ v: string }>();
      const lastReset = Number(lastResetRow?.v ?? 0);
      // Only run if last reset was more than 23 hours ago (prevents same-day double-fire)
      if (now - lastReset > 23 * 3600) {
        ctx.waitUntil(runDemoReset(env.DB));
      }
    }

    const due = await getDueDomains(env.DB, now, 45);
    if (due.length === 0) return;

    const lookups = await Promise.allSettled(
      due.map((d) => lookupDomain(d.fqdn, { bootstrapKV: env.BOOTSTRAP, rdapBaseUrl: env.RDAP_BASE_URL })),
    );

    const updates: Parameters<typeof recordCheckBatch>[1] = [];
    const alertsToFire: Array<{
      domain: (typeof due)[number];
      transition: { fqdn: string; oldStatus: string | null; newStatus: string; detectedAt: number; rdap?: { source?: string } };
      channels: Awaited<ReturnType<typeof getChannelsForDomain>>;
    }> = [];

    for (let i = 0; i < due.length; i++) {
      const d = due[i]!;
      const res = lookups[i]!;
      const nextDueAt = now + d.cadence_minutes * 60;

      if (res.status === "rejected" || res.value.status === "indeterminate") {
        // Preserve existing pending confirmation state — transient outages must not reset the streak
        updates.push({
          fqdn: d.fqdn,
          checkedAt: now,
          nextDueAt,
          pendingConfirmStatus: d.pending_confirm_status ?? null,
          pendingConfirmCount: d.pending_confirm_count ?? 0,
        });
        ctx.waitUntil(
          appendEvent(env.EVENTS, {
            ts: now,
            kind: "indeterminate",
            fqdn: d.fqdn,
            data: {
              reason:
                res.status === "rejected"
                  ? "lookup-error"
                  : (res.value as { reason?: string }).reason,
            },
          }),
        );
        continue;
      }

      const observed = res.value.status;
      const lastStatus = d.last_status ?? null;

      const requiresConfirmation = ALERTABLE_STATUSES.has(observed);

      let newConfirmStatus: string | null = d.pending_confirm_status ?? null;
      let newConfirmCount = d.pending_confirm_count ?? 0;
      let commitStatus = false;

      if (requiresConfirmation) {
        if (d.pending_confirm_status === observed) {
          newConfirmCount += 1;
          if (newConfirmCount >= 2) {
            commitStatus = true;
            newConfirmStatus = null;
            newConfirmCount = 0;
          }
        } else {
          newConfirmStatus = observed;
          newConfirmCount = 1;
        }
      } else {
        commitStatus = true;
        newConfirmStatus = null;
        newConfirmCount = 0;
      }

      const transitionDetected = commitStatus && observed !== lastStatus;

      updates.push({
        fqdn: d.fqdn,
        checkedAt: now,
        nextDueAt,
        newStatus: commitStatus ? observed : undefined,
        pendingConfirmStatus: newConfirmStatus,
        pendingConfirmCount: newConfirmCount,
      });

      if (transitionDetected) {
        const notifyOn = JSON.parse(d.notify_on) as string[];
        if (notifyOn.includes(observed)) {
          const firstFire = await markAlertSeen(env.EVENTS, d.fqdn, observed);
          if (firstFire) {
            const channels = await getChannelsForDomain(env.DB, d.fqdn);
            alertsToFire.push({
              domain: d,
              transition: {
                fqdn: d.fqdn,
                oldStatus: lastStatus,
                newStatus: observed,
                detectedAt: now,
                rdap: res.value.source ? { source: res.value.source } : undefined,
              },
              channels,
            });
            ctx.waitUntil(
              appendEvent(env.EVENTS, {
                ts: now,
                kind: "transition",
                fqdn: d.fqdn,
                data: { from: lastStatus, to: observed },
              }),
            );
          }
        }
      }
    }

    await recordCheckBatch(env.DB, updates);

    for (const a of alertsToFire) {
      ctx.waitUntil(
        dispatchAlert(
          a.domain,
          a.transition as import("./types.js").AlertTransition,
          a.channels,
          { env },
        )
          .then((results) => {
            const tasks = results.map((r) =>
              appendEvent(env.EVENTS, {
                ts: now,
                kind: "alert",
                fqdn: a.domain.fqdn,
                data: { channelId: r.channelId, ok: r.ok, error: r.error, statusCode: r.statusCode },
              }),
            );
            return Promise.all(tasks);
          })
          .catch(() => undefined),
      );
    }
  },
};
