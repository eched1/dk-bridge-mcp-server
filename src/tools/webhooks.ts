import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WebhookConfig, WebhookEvent } from "../types.js";
import { loadStore, saveStore, addWebhook, removeWebhook, getWebhooks } from "../services/store.js";
import { formatSlackPayload } from "../services/webhooks.js";

const WEBHOOK_EVENTS: WebhookEvent[] = [
  "task.created",
  "task.completed",
  "task.updated",
  "task.blocked",
  "task.claimed",
];

export function registerWebhookTools(server: McpServer): void {
  // ── bridge_add_webhook ──────────────────────────────────────────
  server.registerTool(
    "bridge_add_webhook",
    {
      title: "Add Webhook",
      description:
        "Register a webhook URL to receive notifications when bridge events occur.\n" +
        "Supported events: task.created, task.completed, task.updated, task.blocked, task.claimed.\n" +
        "For Slack: use an incoming webhook URL. Payloads include task details and are signed with HMAC-SHA256 if a secret is provided.",
      inputSchema: {
        url: z.string().url().describe("Webhook URL (e.g., Slack incoming webhook URL)"),
        events: z
          .array(z.enum(["task.created", "task.completed", "task.updated", "task.blocked", "task.claimed"]))
          .default(["task.created", "task.completed", "task.blocked"])
          .describe("Events to subscribe to"),
        secret: z
          .string()
          .optional()
          .describe("Optional HMAC secret for payload verification (X-Bridge-Signature header)"),
        headers: z
          .record(z.string())
          .optional()
          .describe("Optional extra headers to include in webhook requests"),
      },
    },
    async ({ url, events, secret, headers }) => {
      const store = loadStore();

      // Check for duplicate
      const existing = getWebhooks(store).find((w) => w.url === url);
      if (existing) {
        existing.events = events;
        existing.enabled = true;
        if (secret) existing.secret = secret;
        if (headers) existing.headers = headers;
        saveStore(store);
        return {
          content: [{ type: "text", text: `Updated existing webhook for ${url}\nEvents: ${events.join(", ")}` }],
        };
      }

      const webhook: WebhookConfig = {
        url,
        events,
        enabled: true,
        secret,
        headers,
      };

      addWebhook(store, webhook);
      saveStore(store);

      return {
        content: [
          {
            type: "text",
            text: `Webhook registered.\n\n**URL**: ${url}\n**Events**: ${events.join(", ")}\n**Signed**: ${secret ? "Yes (HMAC-SHA256)" : "No"}`,
          },
        ],
      };
    }
  );

  // ── bridge_remove_webhook ───────────────────────────────────────
  server.registerTool(
    "bridge_remove_webhook",
    {
      title: "Remove Webhook",
      description: "Remove a registered webhook by URL.",
      inputSchema: {
        url: z.string().describe("Webhook URL to remove"),
      },
    },
    async ({ url }) => {
      const store = loadStore();
      const removed = removeWebhook(store, url);
      if (!removed) {
        return { content: [{ type: "text", text: `No webhook found for ${url}` }] };
      }
      saveStore(store);
      return { content: [{ type: "text", text: `Removed webhook: ${url}` }] };
    }
  );

  // ── bridge_list_webhooks ────────────────────────────────────────
  server.registerTool(
    "bridge_list_webhooks",
    {
      title: "List Webhooks",
      description: "Show all registered webhooks and their event subscriptions.",
      inputSchema: {},
    },
    async () => {
      const store = loadStore();
      const webhooks = getWebhooks(store);

      if (webhooks.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No webhooks registered.\n\nUse `bridge_add_webhook` to register one.\nFor Slack: create an incoming webhook at https://api.slack.com/messaging/webhooks",
            },
          ],
        };
      }

      const lines = ["# Registered Webhooks", ""];
      for (const w of webhooks) {
        lines.push(
          `- **${w.url}**`,
          `  Status: ${w.enabled ? "Enabled" : "Disabled"}`,
          `  Events: ${w.events.join(", ")}`,
          `  Signed: ${w.secret ? "Yes" : "No"}`,
          ""
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── bridge_test_webhook ─────────────────────────────────────────
  server.registerTool(
    "bridge_test_webhook",
    {
      title: "Test Webhook",
      description: "Send a test payload to a registered webhook URL to verify it's working.",
      inputSchema: {
        url: z.string().describe("Webhook URL to test"),
      },
    },
    async ({ url }) => {
      const store = loadStore();
      const webhook = getWebhooks(store).find((w) => w.url === url);

      if (!webhook) {
        return { content: [{ type: "text", text: `No webhook found for ${url}. Register it first with bridge_add_webhook.` }] };
      }

      const testPayload = {
        event: "task.created" as WebhookEvent,
        task: {
          id: "test-0000",
          title: "Test webhook notification",
          description: "This is a test payload to verify webhook delivery.",
          status: "pending" as const,
          priority: "medium" as const,
          source: "cowork" as const,
          tags: ["test"],
          context: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        timestamp: new Date().toISOString(),
        source: "cowork" as const,
      };

      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "User-Agent": "dk-bridge-mcp/2.0",
          ...(webhook.headers || {}),
        };

        // For Slack webhooks, format payload with required `text` field
        const isSlack = url.includes("hooks.slack.com/");
        const finalPayload = isSlack ? formatSlackPayload(testPayload) : testPayload;
        const body = JSON.stringify(finalPayload);

        if (webhook.secret) {
          const { createHmac } = await import("node:crypto");
          const sig = createHmac("sha256", webhook.secret).update(body).digest("hex");
          headers["X-Bridge-Signature"] = `sha256=${sig}`;
        }

        const res = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        });

        if (res.ok) {
          return {
            content: [{ type: "text", text: `Webhook test successful.\n\n**URL**: ${url}\n**Status**: ${res.status} ${res.statusText}` }],
          };
        } else {
          return {
            content: [{ type: "text", text: `Webhook test failed.\n\n**URL**: ${url}\n**Status**: ${res.status} ${res.statusText}\n**Body**: ${await res.text()}` }],
          };
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `Webhook test error: ${err}` }],
        };
      }
    }
  );
}
