#!/usr/bin/env node
/**
 * DK Bridge MCP Server
 *
 * Shared task queue bridging Cowork and Claude Code.
 * Both environments connect via stdio transport.
 * Tasks persist in ~/.dk-infraedge/bridge-tasks.json.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createTask,
  getTask,
  listTasks,
  claimTask,
  updateTask,
  completeTask,
  addContext,
  deleteTask,
  loadStore,
  type Task,
  type TaskStatus,
  type TaskPriority,
  type TaskSource,
} from "./store.js";

// ── Schemas ────────────────────────────────────────────────────────────────

const TaskStatusEnum = z.enum(["pending", "in_progress", "completed", "blocked", "cancelled"]);
const TaskPriorityEnum = z.enum(["critical", "high", "medium", "low"]);
const TaskSourceEnum = z.enum(["cowork", "claude-code", "manual"]);

const CreateTaskSchema = z.object({
  title: z.string().min(1).max(200).describe("Short task title"),
  description: z.string().max(5000).default("").describe("Detailed description of what needs to be done"),
  priority: TaskPriorityEnum.default("medium").describe("Task priority: critical, high, medium, low"),
  source: TaskSourceEnum.describe("Which environment created this task: cowork, claude-code, or manual"),
  tags: z.array(z.string()).default([]).describe("Optional tags for categorization (e.g., ['alpaca-trader', 'deploy'])"),
}).strict();

const ListTasksSchema = z.object({
  status: TaskStatusEnum.optional().describe("Filter by status"),
  source: TaskSourceEnum.optional().describe("Filter by which environment created the task"),
  assignee: TaskSourceEnum.optional().describe("Filter by which environment is working on it"),
  priority: TaskPriorityEnum.optional().describe("Filter by priority"),
  tag: z.string().optional().describe("Filter by tag"),
}).strict();

const TaskIdSchema = z.object({
  id: z.string().min(1).describe("Task ID (8-char hex string)"),
}).strict();

const ClaimTaskSchema = z.object({
  id: z.string().min(1).describe("Task ID to claim"),
  assignee: TaskSourceEnum.describe("Which environment is claiming this task"),
}).strict();

const UpdateTaskSchema = z.object({
  id: z.string().min(1).describe("Task ID to update"),
  status: TaskStatusEnum.optional().describe("New status"),
  priority: TaskPriorityEnum.optional().describe("New priority"),
  assignee: TaskSourceEnum.optional().describe("New assignee"),
  title: z.string().min(1).max(200).optional().describe("New title"),
  description: z.string().max(5000).optional().describe("New description"),
  tags: z.array(z.string()).optional().describe("Replace tags"),
}).strict();

const CompleteTaskSchema = z.object({
  id: z.string().min(1).describe("Task ID to complete"),
  result: z.string().min(1).max(5000).describe("Summary of what was accomplished"),
  source: TaskSourceEnum.describe("Which environment completed this task"),
}).strict();

const AddContextSchema = z.object({
  id: z.string().min(1).describe("Task ID to add context to"),
  source: TaskSourceEnum.describe("Which environment is adding context"),
  message: z.string().min(1).max(5000).describe("Context message, note, or status update"),
}).strict();

// ── Formatters ─────────────────────────────────────────────────────────────

function formatTask(task: Task): string {
  const lines: string[] = [
    `## [${task.id}] ${task.title}`,
    `**Status**: ${task.status} | **Priority**: ${task.priority} | **Source**: ${task.source}`,
  ];
  if (task.assignee) lines.push(`**Assignee**: ${task.assignee}`);
  if (task.tags.length > 0) lines.push(`**Tags**: ${task.tags.join(", ")}`);
  if (task.description) lines.push(`\n${task.description}`);
  if (task.result) lines.push(`\n**Result**: ${task.result}`);
  if (task.context.length > 0) {
    lines.push(`\n### Context (${task.context.length} entries)`);
    for (const entry of task.context.slice(-5)) {
      lines.push(`- **${entry.source}** (${entry.timestamp.slice(0, 16)}): ${entry.message}`);
    }
    if (task.context.length > 5) {
      lines.push(`- ... and ${task.context.length - 5} earlier entries`);
    }
  }
  lines.push(`\n*Created*: ${task.created_at.slice(0, 16)} | *Updated*: ${task.updated_at.slice(0, 16)}`);
  return lines.join("\n");
}

function formatTaskSummary(task: Task): string {
  const assignee = task.assignee ? ` → ${task.assignee}` : "";
  return `[${task.id}] ${task.priority.toUpperCase()} | ${task.status.padEnd(11)} | ${task.title}${assignee}`;
}

// ── Server Setup ───────────────────────────────────────────────────────────

const server = new McpServer({
  name: "dk-bridge-mcp-server",
  version: "1.0.0",
});

// ── Tool: bridge_create_task ───────────────────────────────────────────────

server.registerTool(
  "bridge_create_task",
  {
    title: "Create Bridge Task",
    description: `Create a new task in the shared Cowork ↔ Claude Code task queue.

Use this to hand off work between environments. For example, Cowork can create a task
for Claude Code to deploy something, or Claude Code can create a task for Cowork to
verify a deployment via MCP tools.

Args:
  - title (string): Short task title (required)
  - description (string): Detailed description
  - priority (critical|high|medium|low): Task priority
  - source (cowork|claude-code|manual): Which environment created this
  - tags (string[]): Optional categorization tags

Returns: The created task with its assigned ID.`,
    inputSchema: CreateTaskSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params: z.infer<typeof CreateTaskSchema>) => {
    const task = await createTask(params);
    return {
      content: [{ type: "text" as const, text: `Task created successfully.\n\n${formatTask(task)}` }],
    };
  }
);

// ── Tool: bridge_list_tasks ────────────────────────────────────────────────

server.registerTool(
  "bridge_list_tasks",
  {
    title: "List Bridge Tasks",
    description: `List tasks from the shared task queue with optional filters.

Shows all tasks sorted by priority (critical first) then by creation date.
Use filters to narrow down to specific statuses, sources, or assignees.

Args:
  - status (optional): Filter by task status
  - source (optional): Filter by creating environment
  - assignee (optional): Filter by assigned environment
  - priority (optional): Filter by priority level
  - tag (optional): Filter by tag

Returns: Summary list of matching tasks with IDs, status, and priority.`,
    inputSchema: ListTasksSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: z.infer<typeof ListTasksSchema>) => {
    const tasks = await listTasks(params);
    if (tasks.length === 0) {
      return { content: [{ type: "text" as const, text: "No tasks found matching the given filters." }] };
    }
    const header = `# Bridge Task Queue (${tasks.length} tasks)\n`;
    const lines = tasks.map(formatTaskSummary);
    return {
      content: [{ type: "text" as const, text: header + lines.join("\n") }],
    };
  }
);

// ── Tool: bridge_get_task ──────────────────────────────────────────────────

server.registerTool(
  "bridge_get_task",
  {
    title: "Get Bridge Task",
    description: `Get full details of a specific task by ID, including its context thread.

Args:
  - id (string): The 8-character task ID

Returns: Complete task details with description, context entries, and result.`,
    inputSchema: TaskIdSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: z.infer<typeof TaskIdSchema>) => {
    const task = await getTask(params.id);
    if (!task) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error: Task '${params.id}' not found. Use bridge_list_tasks to see available tasks.` }],
      };
    }
    return { content: [{ type: "text" as const, text: formatTask(task) }] };
  }
);

// ── Tool: bridge_claim_task ────────────────────────────────────────────────

server.registerTool(
  "bridge_claim_task",
  {
    title: "Claim Bridge Task",
    description: `Claim a pending task and mark it as in_progress. Sets the assignee to the
claiming environment (cowork or claude-code).

Args:
  - id (string): Task ID to claim
  - assignee (cowork|claude-code|manual): Which environment is picking this up

Returns: Updated task showing new status and assignee.`,
    inputSchema: ClaimTaskSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: z.infer<typeof ClaimTaskSchema>) => {
    const task = await claimTask(params.id, params.assignee);
    if (!task) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error: Task '${params.id}' not found.` }],
      };
    }
    return {
      content: [{ type: "text" as const, text: `Task claimed by ${params.assignee}.\n\n${formatTask(task)}` }],
    };
  }
);

// ── Tool: bridge_update_task ───────────────────────────────────────────────

server.registerTool(
  "bridge_update_task",
  {
    title: "Update Bridge Task",
    description: `Update one or more fields on an existing task (status, priority, assignee, title, description, tags).

Args:
  - id (string): Task ID to update
  - status (optional): New status
  - priority (optional): New priority
  - assignee (optional): New assignee
  - title (optional): New title
  - description (optional): New description
  - tags (optional): Replace tags array

Returns: Updated task.`,
    inputSchema: UpdateTaskSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: z.infer<typeof UpdateTaskSchema>) => {
    const { id, ...updates } = params;
    const task = await updateTask(id, updates);
    if (!task) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error: Task '${id}' not found.` }],
      };
    }
    return {
      content: [{ type: "text" as const, text: `Task updated.\n\n${formatTask(task)}` }],
    };
  }
);

// ── Tool: bridge_complete_task ─────────────────────────────────────────────

server.registerTool(
  "bridge_complete_task",
  {
    title: "Complete Bridge Task",
    description: `Mark a task as completed with a result summary describing what was accomplished.

Args:
  - id (string): Task ID to complete
  - result (string): Summary of what was done (e.g., "Deployed to k3s, all pods healthy")
  - source (cowork|claude-code|manual): Which environment completed this

Returns: Completed task with result recorded.`,
    inputSchema: CompleteTaskSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: z.infer<typeof CompleteTaskSchema>) => {
    const task = await completeTask(params.id, params.result, params.source);
    if (!task) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error: Task '${params.id}' not found.` }],
      };
    }
    return {
      content: [{ type: "text" as const, text: `Task completed.\n\n${formatTask(task)}` }],
    };
  }
);

// ── Tool: bridge_add_context ───────────────────────────────────────────────

server.registerTool(
  "bridge_add_context",
  {
    title: "Add Context to Bridge Task",
    description: `Add a note or status update to a task's context thread. This creates a
conversation-like history between environments.

Use this to:
- Log progress ("Built Docker image, running tests now")
- Ask questions ("Which namespace should this deploy to?")
- Share blockers ("Alpaca API returning 401, need new keys")

Args:
  - id (string): Task ID
  - source (cowork|claude-code|manual): Which environment is adding this note
  - message (string): The context message

Returns: Updated task showing the new context entry.`,
    inputSchema: AddContextSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params: z.infer<typeof AddContextSchema>) => {
    const task = await addContext(params.id, params.source, params.message);
    if (!task) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error: Task '${params.id}' not found.` }],
      };
    }
    return {
      content: [{ type: "text" as const, text: `Context added.\n\n${formatTask(task)}` }],
    };
  }
);

// ── Tool: bridge_delete_task ───────────────────────────────────────────────

server.registerTool(
  "bridge_delete_task",
  {
    title: "Delete Bridge Task",
    description: `Permanently remove a task from the queue. Use with caution.
Prefer bridge_complete_task or bridge_update_task with status=cancelled instead.

Args:
  - id (string): Task ID to delete

Returns: Confirmation of deletion.`,
    inputSchema: TaskIdSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: z.infer<typeof TaskIdSchema>) => {
    const deleted = await deleteTask(params.id);
    if (!deleted) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error: Task '${params.id}' not found.` }],
      };
    }
    return {
      content: [{ type: "text" as const, text: `Task '${params.id}' deleted permanently.` }],
    };
  }
);

// ── Tool: bridge_dashboard ─────────────────────────────────────────────────

server.registerTool(
  "bridge_dashboard",
  {
    title: "Bridge Dashboard",
    description: `Show a summary dashboard of the entire task queue — counts by status,
recent activity, and any blocked or critical items.

No arguments required.

Returns: Dashboard overview with stats and highlights.`,
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const store = await loadStore();
    const tasks = store.tasks;

    // Status counts
    const statusCounts: Record<string, number> = {};
    for (const t of tasks) {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    }

    // Source counts
    const sourceCounts: Record<string, number> = {};
    for (const t of tasks) {
      sourceCounts[t.source] = (sourceCounts[t.source] || 0) + 1;
    }

    // Critical/blocked items
    const critical = tasks.filter((t) => t.priority === "critical" && t.status !== "completed");
    const blocked = tasks.filter((t) => t.status === "blocked");
    const inProgress = tasks.filter((t) => t.status === "in_progress");

    const lines: string[] = [
      "# DK Bridge Dashboard",
      "",
      `**Total tasks**: ${tasks.length} | **Last sync**: ${store.last_sync.slice(0, 16)}`,
      "",
      "## Status Breakdown",
      ...Object.entries(statusCounts).map(([s, c]) => `- ${s}: ${c}`),
      "",
      "## By Source",
      ...Object.entries(sourceCounts).map(([s, c]) => `- ${s}: ${c}`),
    ];

    if (critical.length > 0) {
      lines.push("", "## Critical Items");
      for (const t of critical) lines.push(`- [${t.id}] ${t.title} (${t.status})`);
    }

    if (blocked.length > 0) {
      lines.push("", "## Blocked Items");
      for (const t of blocked) lines.push(`- [${t.id}] ${t.title}`);
    }

    if (inProgress.length > 0) {
      lines.push("", "## In Progress");
      for (const t of inProgress) {
        const assignee = t.assignee ? ` → ${t.assignee}` : "";
        lines.push(`- [${t.id}] ${t.title}${assignee}`);
      }
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("DK Bridge MCP server running via stdio");
  console.error(`Store path: ${process.env.BRIDGE_STORE_PATH || `${process.env.HOME}/.dk-infraedge/bridge-tasks.json`}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
