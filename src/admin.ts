import type { Env, ChannelType, DomainRow } from "./types.js";
import {
  listDomains,
  getDomain,
  deleteDomain,
  updateDomain,
  upsertDomainWithBudgetCheck,
  listChannels,
  getChannel,
  createChannel,
  updateChannel,
  deleteChannel,
  getChannelsForDomain,
  linkChannel,
  unlinkChannel,
  getConfig,
  setConfig,
} from "./db.js";
import { listEvents } from "./kv.js";
import { computeBudget, pickLeastLoadedOffset } from "./budget.js";
import { isWebhookAllowed, parseAllowlist } from "./webhooks.js";
import { detectWebhookType } from "./alerts.js";
import { lookupDomain } from "./rdap.js";

const JSON_HEADERS: HeadersInit = {
  "content-type": "application/json",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

const DASHBOARD_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'";

const SECURITY_HEADERS: HeadersInit = {
  "content-type": "text/plain",
  "Content-Security-Policy": DASHBOARD_CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function jsonErr(status: number, message: string, extra?: Record<string, unknown>): Response {
  return json({ error: message, ...extra }, status);
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length === bb.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function resolveAdminToken(env: Env): string | null {
  const t = env.ADMIN_TOKEN?.trim()
  return t && t.length > 0 ? t : null
}

async function checkAuth(req: Request, env: Env): Promise<boolean> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match) return false;
  const provided = match[1] ?? "";
  const token = resolveAdminToken(env);
  if (!token) return false;
  return timingSafeEqual(provided, token);
}

const VALID_NOTIFY_ON = new Set(["available", "dropping", "expiring", "registered"]);
const VALID_CHANNEL_TYPES = new Set<ChannelType>([
  "email",
  "webhook-generic",
  "webhook-teams",
  "webhook-slack",
  "webhook-discord",
]);
const FQDN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const EMAIL_RE = /^[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

interface ValidationOk<T> { ok: true; value: T }
interface ValidationFail { ok: false; errors: string[] }
type ValidationResult<T> = ValidationOk<T> | ValidationFail;

function validateFqdn(raw: unknown): { fqdn?: string; error?: string } {
  if (typeof raw !== "string" || raw.trim() === "") return { error: "fqdn: required string" };
  const lower = raw.trim().toLowerCase();
  if (!FQDN_RE.test(lower)) return { error: `fqdn: invalid format '${lower}'` };
  return { fqdn: lower };
}

function validateCadence(raw: unknown, fallback: number): { cadence?: number; error?: string } {
  if (raw === undefined || raw === null) return { cadence: fallback };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1440) return { error: "cadenceMinutes: integer [1..1440]" };
  return { cadence: n };
}

function validateNotifyOn(raw: unknown): { notifyOn?: string[]; error?: string } {
  if (raw === undefined || raw === null) return { notifyOn: ["available", "dropping"] };
  if (!Array.isArray(raw)) return { error: "notifyOn: must be array" };
  const invalid = (raw as unknown[]).filter((v) => typeof v !== "string" || !VALID_NOTIFY_ON.has(v as string));
  if (invalid.length > 0) return { error: `notifyOn: invalid values: ${invalid.join(", ")}` };
  return { notifyOn: raw as string[] };
}

async function validateChannelIds(
  db: D1Database,
  raw: unknown,
): Promise<{ channels?: string[]; error?: string }> {
  if (raw === undefined || raw === null) return { channels: [] };
  if (!Array.isArray(raw)) return { error: "channels: must be array" };
  const ids = raw as unknown[];
  if (ids.some((v) => typeof v !== "string")) return { error: "channels: all entries must be strings" };
  const strIds = ids as string[];
  for (const id of strIds) {
    const ch = await getChannel(db, id);
    if (!ch) return { error: `channels: channel '${id}' not found` };
  }
  return { channels: strIds };
}

interface DomainInput {
  fqdn: string;
  cadenceMinutes: number;
  channels: string[];
  notifyOn: string[];
  label?: string;
}

async function validateDomainInput(
  db: D1Database,
  body: Record<string, unknown>,
  defaultCadence: number,
): Promise<ValidationResult<DomainInput>> {
  const errors: string[] = [];

  const fqdnResult = validateFqdn(body["fqdn"]);
  if (fqdnResult.error) errors.push(fqdnResult.error);

  const cadenceResult = validateCadence(body["cadenceMinutes"], defaultCadence);
  if (cadenceResult.error) errors.push(cadenceResult.error);

  const notifyOnResult = validateNotifyOn(body["notifyOn"]);
  if (notifyOnResult.error) errors.push(notifyOnResult.error);

  const channelResult = await validateChannelIds(db, body["channels"]);
  if (channelResult.error) errors.push(channelResult.error);

  if (errors.length > 0) return { ok: false, errors };

  const label = typeof body["label"] === "string" ? body["label"] : undefined;

  return {
    ok: true,
    value: {
      fqdn: fqdnResult.fqdn!,
      cadenceMinutes: cadenceResult.cadence!,
      channels: channelResult.channels!,
      notifyOn: notifyOnResult.notifyOn!,
      label,
    },
  };
}

async function getDefaultCadence(db: D1Database): Promise<number> {
  const v = await getConfig(db, "default_cadence_minutes");
  if (v) {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return 60;
}

async function buildBudgetSnapshot(db: D1Database): Promise<ReturnType<typeof computeBudget>> {
  const domains = await listDomains(db, { includePaused: true });
  return computeBudget({
    domains: domains.map((d) => ({
      cadenceMinutes: d.cadence_minutes,
      phaseOffsetMinutes: d.phase_offset_minutes,
      paused: d.paused !== 0,
      tldSupported: d.tld_supported !== 0,
    })),
  });
}

async function insertDomainWithChannels(
  db: D1Database,
  input: DomainInput,
): Promise<{ inserted: boolean; reason?: string; domain?: DomainRow }> {
  const allDomains = await listDomains(db, { includePaused: true });
  const existingForOffset = allDomains
    .filter((d) => d.paused === 0 && d.tld_supported !== 0)
    .map((d) => ({ cadenceMinutes: d.cadence_minutes, phaseOffsetMinutes: d.phase_offset_minutes }));

  const offset = pickLeastLoadedOffset(existingForOffset, input.cadenceMinutes);
  const now = Math.floor(Date.now() / 1000);

  const result = await upsertDomainWithBudgetCheck(
    db,
    {
      fqdn: input.fqdn,
      cadence_minutes: input.cadenceMinutes,
      phase_offset_minutes: offset,
      next_due_at: now,
      paused: 0,
      notify_on: JSON.stringify(input.notifyOn),
      label: input.label ?? null,
      tld_supported: 1,
    },
    45,
  );

  if (!result.inserted) return { inserted: false, reason: result.reason };

  for (const chId of input.channels) {
    await linkChannel(db, input.fqdn, chId);
  }

  const domain = await getDomain(db, input.fqdn);
  return { inserted: true, domain: domain ?? undefined };
}

async function handleGetDomains(env: Env): Promise<Response> {
  const domains = await listDomains(env.DB, { includePaused: true });
  const result = await Promise.all(
    domains.map(async (d) => {
      const channels = await getChannelsForDomain(env.DB, d.fqdn);
      return { ...d, notify_on: JSON.parse(d.notify_on) as unknown, channel_ids: channels.map((c) => c.id) };
    }),
  );
  return json(result);
}

async function handlePostDomain(req: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "validation_failed", { details: ["body: invalid JSON"] });
  }

  const defaultCadence = await getDefaultCadence(env.DB);
  const validation = await validateDomainInput(env.DB, body, defaultCadence);
  if (!validation.ok) return jsonErr(400, "validation_failed", { details: validation.errors });

  const budgetBefore = await buildBudgetSnapshot(env.DB);
  const { inserted, reason, domain } = await insertDomainWithChannels(env.DB, validation.value);

  if (!inserted) {
    const budgetAfter = await buildBudgetSnapshot(env.DB);
    return jsonErr(400, "budget_exceeded", { reason, budgetBefore, budgetAfter });
  }

  return json(domain, 201);
}

async function handlePostDomainsBulk(req: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "validation_failed", { details: ["body: invalid JSON"] });
  }

  const rawDomains = body["domains"];
  if (!Array.isArray(rawDomains)) {
    return jsonErr(400, "validation_failed", { details: ["domains: required array"] });
  }

  const dryRun = body["dryRun"] === true;
  const defaultCadence = await getDefaultCadence(env.DB);
  const budgetBefore = await buildBudgetSnapshot(env.DB);

  const accepted: DomainRow[] = [];
  const rejected: Array<{ fqdn: unknown; reason: string }> = [];

  for (const item of rawDomains as unknown[]) {
    const itemBody = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const validation = await validateDomainInput(env.DB, itemBody, defaultCadence);
    if (!validation.ok) {
      rejected.push({ fqdn: itemBody["fqdn"], reason: validation.errors.join("; ") });
      continue;
    }

    if (dryRun) {
      accepted.push({
        fqdn: validation.value.fqdn,
        added_at: 0,
        cadence_minutes: validation.value.cadenceMinutes,
        phase_offset_minutes: 0,
        next_due_at: 0,
        paused: 0,
        last_status: null,
        last_status_changed_at: null,
        last_checked_at: null,
        pending_confirm_status: null,
        pending_confirm_count: null,
        notify_on: JSON.stringify(validation.value.notifyOn),
        label: validation.value.label ?? null,
        tld_supported: 1,
      });
    } else {
      const { inserted, reason, domain } = await insertDomainWithChannels(env.DB, validation.value);
      if (inserted && domain) {
        accepted.push(domain);
      } else {
        rejected.push({ fqdn: validation.value.fqdn, reason: reason ?? "budget_exceeded" });
      }
    }
  }

  const budgetAfter = dryRun ? budgetBefore : await buildBudgetSnapshot(env.DB);
  return json({ accepted, rejected, budgetBefore, budgetAfter, dryRun });
}

async function handleGetDomain(fqdn: string, env: Env): Promise<Response> {
  const domain = await getDomain(env.DB, fqdn);
  if (!domain) return jsonErr(404, "not_found");

  const events = await listEvents(env.EVENTS, { fqdn, limit: 20 });
  const channels = await getChannelsForDomain(env.DB, fqdn);
  return json({
    ...domain,
    notify_on: JSON.parse(domain.notify_on) as unknown,
    channel_ids: channels.map((c) => c.id),
    events,
  });
}

async function handlePatchDomain(fqdn: string, req: Request, env: Env): Promise<Response> {
  const domain = await getDomain(env.DB, fqdn);
  if (!domain) return jsonErr(404, "not_found");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "validation_failed", { details: ["body: invalid JSON"] });
  }

  const errors: string[] = [];
  const patch: Partial<{ cadence_minutes: number; paused: number; notify_on: string; label: string }> = {};
  let newCadence: number | undefined;
  let newPhaseOffset: number | undefined;

  if (body["cadenceMinutes"] !== undefined) {
    const res = validateCadence(body["cadenceMinutes"], domain.cadence_minutes);
    if (res.error) errors.push(res.error);
    else if (res.cadence !== undefined) {
      patch.cadence_minutes = res.cadence;
      newCadence = res.cadence;
    }
  }

  if (body["paused"] !== undefined) {
    if (typeof body["paused"] !== "boolean") errors.push("paused: must be boolean");
    else patch.paused = body["paused"] ? 1 : 0;
  }

  if (body["notifyOn"] !== undefined) {
    const res = validateNotifyOn(body["notifyOn"]);
    if (res.error) errors.push(res.error);
    else if (res.notifyOn) patch.notify_on = JSON.stringify(res.notifyOn);
  }

  if (body["label"] !== undefined) {
    if (typeof body["label"] !== "string") errors.push("label: must be string");
    else patch.label = body["label"];
  }

  if (errors.length > 0) return jsonErr(400, "validation_failed", { details: errors });

  if (newCadence !== undefined && newCadence !== domain.cadence_minutes) {
    const allDomains = await listDomains(env.DB, { includePaused: true });
    const othersForOffset = allDomains
      .filter((d) => d.fqdn !== fqdn && d.paused === 0 && d.tld_supported !== 0)
      .map((d) => ({ cadenceMinutes: d.cadence_minutes, phaseOffsetMinutes: d.phase_offset_minutes }));
    const offset = pickLeastLoadedOffset(othersForOffset, newCadence);
    const simulated = [
      ...othersForOffset,
      { cadenceMinutes: newCadence, phaseOffsetMinutes: offset },
    ];
    const budgetCheck = computeBudget({
      domains: simulated.map((d) => ({ ...d, paused: false, tldSupported: true })),
    });
    if (budgetCheck.peakDuePerMinute > 45) {
      return jsonErr(400, "budget_exceeded", { budget: budgetCheck });
    }
    newPhaseOffset = offset;
    await env.DB.prepare(`UPDATE domains SET cadence_minutes = ?, phase_offset_minutes = ? WHERE fqdn = ?`)
      .bind(newCadence, offset, fqdn)
      .run();
    delete patch.cadence_minutes;
  }

  if (body["channels"] !== undefined) {
    const chRes = await validateChannelIds(env.DB, body["channels"]);
    if (chRes.error) return jsonErr(400, "validation_failed", { details: [chRes.error] });
    const existing = await getChannelsForDomain(env.DB, fqdn);
    for (const ch of existing) {
      await unlinkChannel(env.DB, fqdn, ch.id);
    }
    for (const chId of chRes.channels!) {
      await linkChannel(env.DB, fqdn, chId);
    }
  }

  const updated = await updateDomain(env.DB, fqdn, patch);
  if (!updated) return jsonErr(404, "not_found");

  const finalDomain = newPhaseOffset !== undefined ? await getDomain(env.DB, fqdn) : updated;
  if (!finalDomain) return jsonErr(404, "not_found");
  return json({ ...finalDomain, notify_on: JSON.parse(finalDomain.notify_on) as unknown });
}

async function handleDeleteDomain(fqdn: string, env: Env): Promise<Response> {
  const deleted = await deleteDomain(env.DB, fqdn);
  if (!deleted) return jsonErr(404, "not_found");
  return json({ deleted: true });
}

async function handleGetChannels(env: Env): Promise<Response> {
  const channels = await listChannels(env.DB);
  return json(channels);
}

async function handlePostChannel(req: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "validation_failed", { details: ["body: invalid JSON"] });
  }

  const errors: string[] = [];

  let rawType = body["type"];
  let resolvedType: ChannelType | undefined;

  if (typeof rawType !== "string" || rawType.trim() === "") {
    errors.push("type: required string");
  } else {
    if (rawType === "webhook") {
      rawType = typeof body["target"] === "string"
        ? detectWebhookType(body["target"])
        : "webhook-generic";
    }
    if (!VALID_CHANNEL_TYPES.has(rawType as ChannelType)) {
      errors.push(`type: must be one of ${[...VALID_CHANNEL_TYPES].join(", ")}`);
    } else {
      resolvedType = rawType as ChannelType;
    }
  }

  const targetRaw = body["target"];
  if (typeof targetRaw !== "string" || targetRaw.trim() === "") {
    errors.push("target: required string");
  } else if (resolvedType !== undefined) {
    const target = targetRaw.trim();
    if (resolvedType === "email" && !EMAIL_RE.test(target)) {
      errors.push("target: invalid email address");
    } else if (resolvedType.startsWith("webhook")) {
      const allowlist = parseAllowlist(env.WEBHOOK_HOST_ALLOWLIST, env.WEBHOOK_HOST_ALLOWLIST_DEFAULT);
      const check = isWebhookAllowed(target, allowlist);
      if (!check.allowed) {
        errors.push(`target: webhook host not in allowlist (${check.reason ?? "not-allowed"})`);
      }
    }
  }

  if (errors.length > 0) return jsonErr(400, "validation_failed", { details: errors });

  const channel = await createChannel(env.DB, {
    id: crypto.randomUUID(),
    type: resolvedType!,
    target: (body["target"] as string).trim(),
    label: typeof body["label"] === "string" ? body["label"] : null,
    disabled: 0,
  });

  return json(channel, 201);
}

async function handlePatchChannel(id: string, req: Request, env: Env): Promise<Response> {
  const channel = await getChannel(env.DB, id);
  if (!channel) return jsonErr(404, "not_found");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "validation_failed", { details: ["body: invalid JSON"] });
  }

  const errors: string[] = [];
  const patch: Partial<{ disabled: number; target: string; label: string }> = {};

  if (body["disabled"] !== undefined) {
    if (typeof body["disabled"] !== "boolean") errors.push("disabled: must be boolean");
    else patch.disabled = body["disabled"] ? 1 : 0;
  }

  if (body["target"] !== undefined) {
    if (typeof body["target"] !== "string" || body["target"].trim() === "") {
      errors.push("target: must be non-empty string");
    } else {
      const newTarget = body["target"].trim();
      if (channel.type === "email" && !EMAIL_RE.test(newTarget)) {
        errors.push("target: invalid email address");
      } else if (channel.type.startsWith("webhook")) {
        const allowlist = parseAllowlist(env.WEBHOOK_HOST_ALLOWLIST, env.WEBHOOK_HOST_ALLOWLIST_DEFAULT);
        const check = isWebhookAllowed(newTarget, allowlist);
        if (!check.allowed) errors.push(`target: webhook host not in allowlist (${check.reason ?? "not-allowed"})`);
      }
      patch.target = newTarget;
    }
  }

  if (body["label"] !== undefined) {
    if (typeof body["label"] !== "string") errors.push("label: must be string");
    else patch.label = body["label"];
  }

  if (errors.length > 0) return jsonErr(400, "validation_failed", { details: errors });

  const updated = await updateChannel(env.DB, id, patch);
  if (!updated) return jsonErr(404, "not_found");
  return json(updated);
}

async function handleDeleteChannel(id: string, req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";
  const result = await deleteChannel(env.DB, id, force);
  if (!result.deleted) {
    if (result.referencingDomains && result.referencingDomains.length > 0) {
      return jsonErr(409, "channel_in_use", { domains: result.referencingDomains });
    }
    return jsonErr(404, "not_found");
  }
  return json({ deleted: true });
}

async function handleCheckDomain(fqdn: string, env: Env): Promise<Response> {
  const domain = await getDomain(env.DB, fqdn);
  if (!domain) return jsonErr(404, "not_found");

  const result = await lookupDomain(fqdn, {
    bootstrapKV: env.BOOTSTRAP,
    fetchImpl: fetch,
  });

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`UPDATE domains SET last_checked_at = ? WHERE fqdn = ?`)
    .bind(now, fqdn)
    .run();

  return json(result);
}

async function handleGetBudget(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const simulate = url.searchParams.get("simulate");

  if (simulate) {
    const params = new URLSearchParams(simulate);
    const cadenceRaw = params.get("cadence");
    if (!cadenceRaw) return jsonErr(400, "validation_failed", { details: ["simulate: cadence required"] });
    const cadence = parseInt(cadenceRaw, 10);
    if (!Number.isFinite(cadence) || cadence < 1 || cadence > 1440) {
      return jsonErr(400, "validation_failed", { details: ["simulate: cadence must be integer [1..1440]"] });
    }
    const allDomains = await listDomains(env.DB, { includePaused: true });
    const existingInputs = allDomains.map((d) => ({
      cadenceMinutes: d.cadence_minutes,
      phaseOffsetMinutes: d.phase_offset_minutes,
      paused: d.paused !== 0,
      tldSupported: d.tld_supported !== 0,
    }));
    const activeForOffset = existingInputs
      .filter((d) => !d.paused && d.tldSupported)
      .map((d) => ({ cadenceMinutes: d.cadenceMinutes, phaseOffsetMinutes: d.phaseOffsetMinutes }));
    const offset = pickLeastLoadedOffset(activeForOffset, cadence);
    const simulated = [
      ...existingInputs,
      { cadenceMinutes: cadence, phaseOffsetMinutes: offset, paused: false, tldSupported: true },
    ];
    const report = computeBudget({ domains: simulated });
    return json(report);
  }

  const report = await buildBudgetSnapshot(env.DB);
  return json(report);
}

async function handleGetEvents(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const fqdn = url.searchParams.get("fqdn") ?? undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 20, 200) : 20;
  const events = await listEvents(env.EVENTS, { fqdn, limit });
  return json(events);
}

export async function handleAdmin(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  if (pathname === "/health" && method === "GET") {
    return json({ ok: true, version: env.VERSION ?? "0.1.0" });
  }

  if ((pathname === "/" || pathname === "/index.html") && method === "GET") {
    if (env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(req);
      const res = new Response(assetRes.body, {
        status: assetRes.status,
        headers: assetRes.headers,
      });
      res.headers.set("Content-Security-Policy", DASHBOARD_CSP);
      res.headers.set("X-Content-Type-Options", "nosniff");
      res.headers.set("Referrer-Policy", "no-referrer");
      res.headers.set("Cache-Control", "no-store");
      return res;
    }
    return new Response(
      "domain-drop-watcher admin — deploy with wrangler assets configured",
      { status: 200, headers: SECURITY_HEADERS },
    );
  }

  if (!(await checkAuth(req, env))) {
    return jsonErr(401, "unauthorized");
  }

  if (pathname === "/domains" && method === "GET") return handleGetDomains(env);
  if (pathname === "/domains" && method === "POST") return handlePostDomain(req, env);
  if (pathname === "/domains/bulk" && method === "POST") return handlePostDomainsBulk(req, env);
  if (pathname === "/domains/pause-all" && method === "POST") {
    await setConfig(env.DB, "global_paused", "1");
    return json({ ok: true });
  }
  if (pathname === "/domains/resume-all" && method === "POST") {
    await setConfig(env.DB, "global_paused", "0");
    return json({ ok: true });
  }

  const domainMatch = /^\/domains\/([^/]+)$/.exec(pathname);
  if (domainMatch) {
    const fqdn = decodeURIComponent(domainMatch[1] ?? "").toLowerCase();
    if (method === "GET") return handleGetDomain(fqdn, env);
    if (method === "PATCH") return handlePatchDomain(fqdn, req, env);
    if (method === "DELETE") return handleDeleteDomain(fqdn, env);
  }

  if (pathname === "/channels" && method === "GET") return handleGetChannels(env);
  if (pathname === "/channels" && method === "POST") return handlePostChannel(req, env);

  const channelMatch = /^\/channels\/([^/]+)$/.exec(pathname);
  if (channelMatch) {
    const id = decodeURIComponent(channelMatch[1] ?? "");
    if (method === "PATCH") return handlePatchChannel(id, req, env);
    if (method === "DELETE") return handleDeleteChannel(id, req, env);
  }

  const checkMatch = /^\/check\/([^/]+)$/.exec(pathname);
  if (checkMatch && method === "POST") {
    const fqdn = decodeURIComponent(checkMatch[1] ?? "").toLowerCase();
    return handleCheckDomain(fqdn, env);
  }

  if (pathname === "/budget" && method === "GET") return handleGetBudget(req, env);
  if (pathname === "/events" && method === "GET") return handleGetEvents(req, env);

  return jsonErr(404, "not_found");
}
