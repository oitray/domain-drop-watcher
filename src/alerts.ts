import type { ChannelRow, DomainRow, Env, AlertTransition } from "./types.js";
import { isWebhookAllowed, parseAllowlist } from "./webhooks.js";
import { recordChannelDelivery } from "./db.js";

export interface AlertContext {
  env: Env;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface DispatchResult {
  channelId: string;
  ok: boolean;
  error?: string;
  statusCode?: number;
}

export function detectWebhookType(url: string): "webhook-teams" | "webhook-slack" | "webhook-discord" | "webhook-generic" {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "webhook-generic";
  }
  if (host === "webhook.office.com" || host.endsWith(".webhook.office.com")) return "webhook-teams";
  if (host === "hooks.slack.com" || host.endsWith(".slack.com")) return "webhook-slack";
  if (host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com")) return "webhook-discord";
  return "webhook-generic";
}

function themeColor(transition: AlertTransition): string {
  const s = transition.newStatus;
  if (s === "dropping" || s === "available") return "e42e1b";
  if (s === "expiring") return "c0392b";
  return "e42e1b";
}

export function formatTeamsCard(domain: DomainRow, transition: AlertTransition): unknown {
  return {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    themeColor: themeColor(transition),
    summary: `Domain drop-watch: ${domain.fqdn}`,
    title: `Domain drop-watch: ${domain.fqdn}`,
    sections: [
      {
        facts: [
          { name: "Domain", value: domain.fqdn },
          { name: "Label", value: domain.label ?? "(none)" },
          { name: "Old status", value: transition.oldStatus ?? "(none)" },
          { name: "New status", value: transition.newStatus },
          { name: "Detected at", value: new Date(transition.detectedAt).toISOString() },
        ],
      },
    ],
  };
}

export function formatSlackBlocks(domain: DomainRow, transition: AlertTransition): unknown {
  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Domain drop-watch: ${domain.fqdn}` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Domain:*\n${domain.fqdn}` },
        { type: "mrkdwn", text: `*Label:*\n${domain.label ?? "(none)"}` },
        { type: "mrkdwn", text: `*Old status:*\n${transition.oldStatus ?? "(none)"}` },
        { type: "mrkdwn", text: `*New status:*\n${transition.newStatus}` },
        { type: "mrkdwn", text: `*Detected at:*\n${new Date(transition.detectedAt).toISOString()}` },
      ],
    },
  ];

  const rdap = (transition as AlertTransition & { rdap?: { source?: string } }).rdap;
  if (rdap?.source) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `RDAP source: ${rdap.source}` }],
    });
  }

  return { blocks };
}

export function formatDiscordEmbed(domain: DomainRow, transition: AlertTransition): unknown {
  return {
    embeds: [
      {
        color: 0xe42e1b,
        title: `Domain drop-watch: ${domain.fqdn}`,
        description: `Status transition detected for **${domain.fqdn}**`,
        fields: [
          { name: "Label", value: domain.label ?? "(none)", inline: true },
          { name: "Old status", value: transition.oldStatus ?? "(none)", inline: true },
          { name: "New status", value: transition.newStatus, inline: true },
        ],
        timestamp: new Date(transition.detectedAt).toISOString(),
      },
    ],
  };
}

export function formatGenericWebhook(domain: DomainRow, transition: AlertTransition): unknown {
  const rdap = (transition as AlertTransition & { rdap?: unknown }).rdap;
  return {
    fqdn: domain.fqdn,
    oldStatus: transition.oldStatus,
    newStatus: transition.newStatus,
    detectedAt: new Date(transition.detectedAt).toISOString(),
    label: domain.label,
    rdap: rdap ?? null,
  };
}

export function formatResendEmail(
  domain: DomainRow,
  transition: AlertTransition,
  fromAddress: string,
  to: string,
): unknown {
  const subject = `[domain-drop-watcher] ${domain.fqdn} → ${transition.newStatus}`;
  const detectedStr = new Date(transition.detectedAt).toISOString();
  const html = `<table style="font-family:sans-serif;border-collapse:collapse;width:100%;max-width:480px">
  <tr><th colspan="2" style="background:#e42e1b;color:#fff;padding:10px;text-align:left">${subject}</th></tr>
  <tr><td style="padding:6px;border:1px solid #ddd">Domain</td><td style="padding:6px;border:1px solid #ddd">${domain.fqdn}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd">Label</td><td style="padding:6px;border:1px solid #ddd">${domain.label ?? "(none)"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd">Old status</td><td style="padding:6px;border:1px solid #ddd">${transition.oldStatus ?? "(none)"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd">New status</td><td style="padding:6px;border:1px solid #ddd">${transition.newStatus}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd">Detected at</td><td style="padding:6px;border:1px solid #ddd">${detectedStr}</td></tr>
</table>`;
  const text = `[domain-drop-watcher] ${domain.fqdn} → ${transition.newStatus}\n\nDomain: ${domain.fqdn}\nLabel: ${domain.label ?? "(none)"}\nOld status: ${transition.oldStatus ?? "(none)"}\nNew status: ${transition.newStatus}\nDetected at: ${detectedStr}`;
  return { from: fromAddress, to, subject, html, text };
}

function buildWebhookBody(
  type: "webhook-teams" | "webhook-slack" | "webhook-discord" | "webhook-generic",
  domain: DomainRow,
  transition: AlertTransition,
): unknown {
  if (type === "webhook-teams") return formatTeamsCard(domain, transition);
  if (type === "webhook-slack") return formatSlackBlocks(domain, transition);
  if (type === "webhook-discord") return formatDiscordEmbed(domain, transition);
  return formatGenericWebhook(domain, transition);
}

export async function dispatchAlert(
  domain: DomainRow,
  transition: AlertTransition,
  channels: ChannelRow[],
  ctx: AlertContext,
): Promise<DispatchResult[]> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const nowFn = ctx.now ?? (() => Date.now());

  const settled = await Promise.allSettled(
    channels.map(async (channel): Promise<DispatchResult> => {
      if (channel.disabled !== 0) {
        return { channelId: channel.id, ok: true, error: "disabled-skip" };
      }

      let result: DispatchResult;

      if (channel.type === "email") {
        const apiKey = ctx.env.RESEND_API_KEY;
        const fromAddress = ctx.env.RESEND_FROM_ADDRESS;
        if (!apiKey || !fromAddress) {
          result = { channelId: channel.id, ok: false, error: "resend-not-configured" };
        } else {
          const body = formatResendEmail(domain, transition, fromAddress, channel.target);
          try {
            const resp = await fetchImpl("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
              },
              body: JSON.stringify(body),
            });
            result = { channelId: channel.id, ok: resp.ok, statusCode: resp.status };
            if (!resp.ok) result.error = `resend-http-${resp.status}`;
          } catch (e) {
            result = { channelId: channel.id, ok: false, error: String(e) };
          }
        }
      } else {
        const allowlist = parseAllowlist(
          ctx.env.WEBHOOK_HOST_ALLOWLIST,
          ctx.env.WEBHOOK_HOST_ALLOWLIST_DEFAULT,
        );
        const check = isWebhookAllowed(channel.target, allowlist);
        if (!check.allowed) {
          result = { channelId: channel.id, ok: false, error: `not-allowed:${check.reason ?? "unknown"}` };
        } else {
          const webhookType =
            channel.type === "webhook-teams" ||
            channel.type === "webhook-slack" ||
            channel.type === "webhook-discord" ||
            channel.type === "webhook-generic"
              ? channel.type
              : detectWebhookType(channel.target);
          const body = buildWebhookBody(webhookType, domain, transition);
          try {
            const resp = await fetchImpl(channel.target, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            result = { channelId: channel.id, ok: resp.ok, statusCode: resp.status };
            if (!resp.ok) result.error = `webhook-http-${resp.status}`;
          } catch (e) {
            result = { channelId: channel.id, ok: false, error: String(e) };
          }
        }
      }

      await recordChannelDelivery(
        ctx.env.DB,
        channel.id,
        result.ok ? "ok" : (result.error ?? "error"),
        nowFn(),
      );

      return result;
    }),
  );

  return settled.map((s) => {
    if (s.status === "fulfilled") return s.value;
    return { channelId: "unknown", ok: false, error: String(s.reason) };
  });
}
