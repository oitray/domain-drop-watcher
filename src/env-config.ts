import type { Env } from "./types.js";

const ALERT_FROM_KEY = "ALERT_FROM_ADDRESS";
const WEBHOOK_ALLOWLIST_KEY = "WEBHOOK_HOST_ALLOWLIST";

function readEnvString(env: Env, key: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function getAlertFromAddress(env: Env): string | undefined {
  return readEnvString(env, ALERT_FROM_KEY);
}

export function getWebhookHostAllowlist(env: Env): string | undefined {
  return readEnvString(env, WEBHOOK_ALLOWLIST_KEY);
}
