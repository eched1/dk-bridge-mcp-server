import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Task, TaskContext } from "../types.js";
import {
  loadStore,
  saveStore,
  generateId,
  findTask,
  formatTask,
} from "../services/store.js";
import { fireWebhooks } from "../services/webhooks.js";

const SOURCE_ENUM = z.enum(["cowork", "claude-code", "manual"]);
const STATUS_ENUM = z.enum(["pending", "in_progress", "completed", "blocked", "cancelled"]);
const PRIORITY_ENUM = z.enum(["critical", "high", "medium", "low"]);

export function registerTaskTools(server: McpServer): void {
  // ── bridge_create_task ──────────────────────────────────────────
  server.registerTool(
    "bridge_create_task",
    {
      title: "Create Bridge Task",
      description:
        "Create a new task in the shared Cowork <-> Claude Code task queue.\n" +
        "Use this to hand off work between environments.",
      inputSchema: {
        title: z.string().describe("Short task title"),
        description: z.string().default("").describe("Detailed description"),
        priority: PRIORITY_ENUM.default("medium").describe("Task priority"),
        source: SOURCE_ENUM.describe("Which environment created this task"),
        tags: z.array(z.string()).default([]).describe("Optional tags"),
      },
    },
    async ({ title, description, priority, source, tags }) => {
      const store = loadStore();
      const now = new Date().toISOString();
      const task: Task = {
        id: generateId(),
        title,
        description: description || "",
        status: "pending",
        priority: priority || "medium",
        source,
        tags: tags || [],
        context: [],
        createdAt: now,
        updatedAt: now,
      };
      store.tasks.push(task);
      saveStore(store);

      // Fire webhooks (non-blocking)
      fireWebhooks("task.created", task, source);

      return {
        content: [
          {
            type: "text",
            text: `Task created successfully.\n\n${formatTask(task)}`,
          },
        ],
      };
    }
  );

  // ── bridge_list_tasks ───────────────────────────────────────────
  server.registerTool(
    "bridge_list_tasks",
    {
      title: "List Bridge Tasks",
      description:
        "List tasks from the shared task queue with optional filters.\n" +
        "Shows all tasks sorted by priority (critical first) then by creation date.",
      inputSchema: {
        status: STATUS_ENUM.optional().describe("Filter by status"),
        source: SOURCE_ENUM.optional().describe("Filter by creating environment"),
        assignee: z.string().optional().describe("Filter by assigned environment"),
        priority: PRIORITY_ENUM.optional().describe("Filter by priority"),
        tag: z.string().optional().describe("Filter by tag"),
      },
    },
    async ({ status, source, assignee, priority, tag }) => {
      const store = loadStore();
      let tasks = store.tasks;

      if (status) tasks = tasks.filter((t) => t.status === status);
      if (source) tasks = tasks.filter((t) => t.source === source);
      if (assignee) tasks = tasks.filter((t) => t.assignee === assignee);
      if (priority) tasks = tasks.filter((t) => t.priority === priority);
      if (tag) tasks = tasks.filter((t) => t.tags.includes(tag));

      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      tasks.sort(
        (a, b) =>
          (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9) ||
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );

      const lines = [`# Bridge Task Queue (${tasks.length} tasks)`];
      for (const t of tasks) {
        lines.push(
          `[${t.id}] ${t.priority.toUpperCase()} | ${t.status.padEnd(11)} | ${t.title}`
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── bridge_get_task ─────────────────────────────────────────────
  server.registerTool(
    "bridge_get_task",
    {
      title: "Get Bridge Task",
      description: "Get full details on a specific task by ID (or partial ID).",
      inputSchema: {
        id: z.string().describe("Task ID or prefix"),
      },
    },
    async ({ id }) => {
      const store = loadStore();
      const task = findTask(store, id);
      if (!task) {
        return { content: [{ type: "text", text: `No task found matching '${id}'` }] };
      }
      return { content: [{ type: "text", text: formatTask(task) }] };
    }
  );

  // ── bridge_update_task ──────────────────────────────────────────
  server.registerTool(
    "bridge_update_task",
    {
      title: "Update Bridge Task",
      description: "Update one or more fields on an existing task.",
      inputSchema: {
        id: z.string().describe("Task ID to update"),
        status: STATUS_ENUM.optional(),
        priority: PRIORITY_ENUM.optional(),
        assignee: SOURCE_ENUM.optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ id, status, priority, assignee, title, description, tags }) => {
      const store = loadStore();
      const task = findTask(store, id);
      if (!task) {
        return { content: [{ type: "text", text: `No task found matching '${id}'` }] };
      }

      if (status) task.status = status;
      if (priority) task.priority = priority;
      if (assignee) task.assignee = assignee;
      if (title) task.title = title;
      if (description !== undefined) task.description = description;
      if (tags) task.tags = tags;
      task.updatedAt = new Date().toISOString();

      saveStore(store);

      // Fire webhook for status changes
      if (status === "blocked") {
        fireWebhooks("task.blocked", task, task.source);
      } else if (status) {
        fireWebhooks("task.updated", task, task.source);
      }

      return {
        content: [{ type: "text", text: `Task updated.\n\n${formatTask(task)}` }],
      };
    }
  );

  // ── bridge_complete_task ────────────────────────────────────────
  server.registerTool(
    "bridge_complete_task",
    {
      title: "Complete Bridge Task",
      description: "Mark a task as completed with a result summary.",
      inputSchema: {
        id: z.string().describe("Task ID to complete"),
        result: z.string().describe("Summary of what was accomplished"),
        source: SOURCE_ENUM.describe("Which environment completed this"),
      },
    },
    async ({ id, result, source }) => {
      const store = loadStore();
      const task = findTask(store, id);
      if (!task) {
        return { content: [{ type: "text", text: `No task found matching '${id}'` }] };
      }

      task.status = "completed";
      task.result = result;
      task.updatedAt = new Date().toISOString();
      task.context.push({
        source,
        timestamp: task.updatedAt,
        message: `Completed: ${result}`,
      });

      saveStore(store);
      fireWebhooks("task.completed", task, source);

      return {
        content: [{ type: "text", text: `Task completed.\n\n${formatTask(task)}` }],
      };
    }
  );

  // ── bridge_claim_task ───────────────────────────────────────────
  server.registerTool(
    "bridge_claim_task",
    {
      title: "Claim Bridge Task",
      description: "Claim a pending task and set it to in_progress.",
      inputSchema: {
        id: z.string().describe("Task ID to claim"),
        source: SOURCE_ENUM.describe("Which environment is claiming this"),
      },
    },
    async ({ id, source }) => {
      const store = loadStore();
      const task = findTask(store, id);
      if (!task) {
        return { content: [{ type: "text", text: `No task found matching '${id}'` }] };
      }

      task.status = "in_progress";
      task.assignee = source;
      task.updatedAt = new Date().toISOString();
      task.context.push({
        source,
        timestamp: task.updatedAt,
        message: `Claimed by ${source}`,
      });

      saveStore(store);
      fireWebhooks("task.claimed", task, source);

      return {
        content: [{ type: "text", text: `Task claimed.\n\n${formatTask(task)}` }],
      };
    }
  );

  // ── bridge_add_context ──────────────────────────────────────────
  server.registerTool(
    "bridge_add_context",
    {
      title: "Add Context to Task",
      description: "Add a context note to a task without changing its status.",
      inputSchema: {
        id: z.string().describe("Task ID"),
        message: z.string().describe("Context message"),
        source: SOURCE_ENUM.describe("Which environment is adding context"),
      },
    },
    async ({ id, message, source }) => {
      const store = loadStore();
      const task = findTask(store, id);
      if (!task) {
        return { content: [{ type: "text", text: `No task found matching '${id}'` }] };
      }

      const ctx: TaskContext = {
        source,
        timestamp: new Date().toISOString(),
        message,
      };
      task.context.push(ctx);
      task.updatedAt = ctx.timestamp;

      saveStore(store);

      return {
        content: [{ type: "text", text: `Context added.\n\n${formatTask(task)}` }],
      };
    }
  );

  // ── bridge_delete_task ──────────────────────────────────────────
  server.registerTool(
    "bridge_delete_task",
    {
      title: "Delete Bridge Task",
      description: "Remove a task from the queue entirely.",
      inputSchema: {
        id: z.string().describe("Task ID to delete"),
      },
    },
    async ({ id }) => {
      const store = loadStore();
      const before = store.tasks.length;
      store.tasks = store.tasks.filter((t) => t.id !== id && !t.id.startsWith(id));
      if (store.tasks.length === before) {
        return { content: [{ type: "text", text: `No task found matching '${id}'` }] };
      }
      saveStore(store);
      return {
        content: [
          { type: "text", text: `Deleted ${before - store.tasks.length} task(s).` },
        ],
      };
    }
  );

  // ── bridge_dashboard ────────────────────────────────────────────
  server.registerTool(
    "bridge_dashboard",
    {
      title: "Bridge Dashboard",
      description: "Show a summary dashboard of the entire task queue.",
      inputSchema: {},
    },
    async () => {
      const store = loadStore();
      const tasks = store.tasks;

      const byStatus: Record<string, number> = {};
      const bySource: Record<string, number> = {};
      for (const t of tasks) {
        byStatus[t.status] = (byStatus[t.status] || 0) + 1;
        bySource[t.source] = (bySource[t.source] || 0) + 1;
      }

      const webhookCount = (store.webhooks || []).filter((w) => w.enabled).length;

      const lines = [
        "# DK Bridge Dashboard",
        "",
        `**Total tasks**: ${tasks.length} | **Last sync**: ${store.lastSync}`,
        `**Active webhooks**: ${webhookCount}`,
        "",
        "## Status Breakdown",
        ...Object.entries(byStatus).map(([k, v]) => `- ${k}: ${v}`),
        "",
        "## By Source",
        ...Object.entries(bySource).map(([k, v]) => `- ${k}: ${v}`),
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
