#!/usr/bin/env node

/**
 * DK Bridge MCP Server v2.0.0 — with webhook support.
 * Supports stdio (local) and HTTP/SSE (remote/k8s) transports.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerWebhookTools } from "./tools/webhooks.js";
import { loadStore } from "./services/store.js";
import express from "express";

function createServer(): McpServer {
  const srv = new McpServer({
    name: "dk-bridge-mcp-server",
    version: "2.0.0",
  });
  registerTaskTools(srv);
  registerWebhookTools(srv);
  return srv;
}

async function main(): Promise<void> {
  const transport = process.env.MCP_TRANSPORT || "stdio";

  if (transport === "http") {
    const app = express();
    const port = parseInt(process.env.PORT || "3000");
    const apiKey = process.env.MCP_API_KEY || "";

    // express.json() must NOT be applied to /mcp — StreamableHTTPServerTransport
    // reads the raw request body stream. If Express parses it first, the transport
    // gets an empty stream and returns "Parse error: Invalid JSON" (-32700).
    app.use((req, res, next) => {
      if (req.path === "/mcp") return next();
      express.json()(req, res, next);
    });

    // Health check
    app.get("/healthz", (_req, res) => {
      res.json({ status: "ok", version: "2.0.0", transport: "http" });
    });

    // Prometheus metrics endpoint for bridge task queue
    app.get("/metrics", (_req, res) => {
      const store = loadStore();
      const statuses = ["pending", "in_progress", "completed", "blocked", "cancelled"];
      const priorities = ["critical", "high", "medium", "low"];
      const lines: string[] = [
        "# HELP bridge_tasks_total Total tasks by status",
        "# TYPE bridge_tasks_total gauge",
        ...statuses.map((s) => {
          const count = store.tasks.filter((t: any) => t.status === s).length;
          return `bridge_tasks_total{status="${s}"} ${count}`;
        }),
        "# HELP bridge_tasks_by_priority Tasks by priority",
        "# TYPE bridge_tasks_by_priority gauge",
        ...priorities.map((p) => {
          const count = store.tasks.filter((t: any) => t.priority === p && t.status !== "completed" && t.status !== "cancelled").length;
          return `bridge_tasks_by_priority{priority="${p}"} ${count}`;
        }),
        "# HELP bridge_tasks_active Active (pending + in_progress) task count",
        "# TYPE bridge_tasks_active gauge",
        `bridge_tasks_active ${store.tasks.filter((t: any) => t.status === "pending" || t.status === "in_progress").length}`,
        "# HELP bridge_webhooks_total Configured webhooks",
        "# TYPE bridge_webhooks_total gauge",
        `bridge_webhooks_total ${(store.webhooks || []).length}`,
      ];
      res.set("Content-Type", "text/plain; version=0.0.4");
      res.send(lines.join("\n") + "\n");
    });

    // Session tracking
    const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

    // MCP endpoint
    app.all("/mcp", async (req, res) => {
      // Auth check
      if (apiKey) {
        const auth = req.headers.authorization;
        if (!auth || auth !== `Bearer ${apiKey}`) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
      }

      // Handle existing sessions
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.transport.handleRequest(req, res);
        return;
      }

      // DELETE = close session
      if (req.method === "DELETE" && sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          await session.server.close();
          sessions.delete(sessionId);
        }
        res.status(204).end();
        return;
      }

      // New session — each session gets its own McpServer instance
      const sessionServer = createServer();
      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport: newTransport, server: sessionServer });
        },
      });

      newTransport.onclose = () => {
        const sid = (newTransport as any).sessionId;
        if (sid) sessions.delete(sid);
      };

      await sessionServer.connect(newTransport);
      await newTransport.handleRequest(req, res);
    });

    app.listen(port, "0.0.0.0", () => {
      console.error(`[dk-bridge] HTTP server on port ${port} (v2.0.0 with webhooks)`);
    });
  } else {
    // stdio transport
    const server = createServer();
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    console.error("[dk-bridge] Server started on stdio (v2.0.0 with webhooks)");
  }
}

main().catch((err) => {
  console.error("[dk-bridge] Fatal:", err);
  process.exit(1);
});
