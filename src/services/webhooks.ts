import { createHmac } from "node:crypto";
import type { Task, TaskSource, WebhookConfig, WebhookEvent, WebhookPayload } from "../types.js";
import { loadStore } from "./store.js";

/**
 * Fire webhooks for a given event.
 * Non-blocking — fires and forgets. Errors are logged but don't block the caller.
 */
export async function fireWebhooks(
  event: WebhookEvent,
  task: Task,
  source: TaskSource
): Promise<void> {
  const store = loadStore();
  const webhooks = (store.webhooks || []).filter(
    (w) => w.enabled && w.events.includes(event)
  );

  if (webhooks.length === 0) return;

  const payload: WebhookPayload = {
    event,
    task,
    timestamp: new Date().toISOString(),
    source,
  };

  const body = JSON.stringify(payload);

  for (const webhook of webhooks) {
    fireOne(webhook, body).catch((err) => {
      console.error(`[webhook] Failed to fire ${event} to ${webhook.url}: ${err}`);
    });
  }
}

function isSlackWebhook(url: string): boolean {
  return url.includes("hooks.slack.com/");
}

async function fireOne(webhook: WebhookConfig, body: string): Promise<void> {
  // For Slack webhooks, reformat payload to include required `text` field
  let finalBody = body;
  if (isSlackWebhook(webhook.url)) {
    const payload: WebhookPayload = JSON.parse(body);
    const slackPayload = formatSlackPayload(payload);
    finalBody = JSON.stringify(slackPayload);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "dk-bridge-mcp/2.0",
    ...(webhook.headers || {}),
  };

  // HMAC signature for webhook verification
  if (webhook.secret) {
    const sig = createHmac("sha256", webhook.secret).update(finalBody).digest("hex");
    headers["X-Bridge-Signature"] = `sha256=${sig}`;
  }

  const res = await fetch(webhook.url, {
    method: "POST",
    headers,
    body: finalBody,
    signal: AbortSignal.timeout(10_000), // 10s timeout
  });

  if (!res.ok) {
    console.error(`[webhook] ${webhook.url} responded ${res.status}: ${await res.text()}`);
  }
}

/**
 * Format a webhook payload as a Slack message.
 * Use this as the webhook URL target with Slack incoming webhooks.
 */
export function formatSlackPayload(payload: WebhookPayload): object {
  const priorityEmoji: Record<string, string> = {
    critical: ":rotating_light:",
    high: ":red_circle:",
    medium: ":large_yellow_circle:",
    low: ":white_circle:",
  };

  const eventLabels: Record<string, string> = {
    "task.created": "New Task",
    "task.completed": "Task Completed",
    "task.updated": "Task Updated",
    "task.blocked": "Task Blocked",
    "task.claimed": "Task Claimed",
  };

  const emoji = priorityEmoji[payload.task.priority] || ":memo:";
  const label = eventLabels[payload.event] || payload.event;

  const blocks: object[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${label}: ${payload.task.title}`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Priority:* ${emoji} ${payload.task.priority}` },
        { type: "mrkdwn", text: `*Source:* ${payload.source}` },
        { type: "mrkdwn", text: `*Status:* ${payload.task.status}` },
        { type: "mrkdwn", text: `*ID:* \`${payload.task.id}\`` },
      ],
    },
  ];

  if (payload.task.description) {
    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: { type: "mrkdwn", text: payload.task.description },
      }
    );
  }

  if (payload.task.tags.length > 0) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: payload.task.tags.map((t) => `\`${t}\``).join("  ") },
      ],
    });
  }

  return {
    text: `${emoji} ${label}: ${payload.task.title}`,
    blocks,
  };
}
