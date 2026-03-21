/**
 * File-based task store for the DK Bridge MCP server.
 * Reads/writes a JSON file at a configurable path (default: ~/.dk-infraedge/bridge-tasks.json).
 * Uses atomic writes to prevent corruption.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
export type TaskPriority = "critical" | "high" | "medium" | "low";
export type TaskSource = "cowork" | "claude-code" | "manual";

export interface ContextEntry {
  id: string;
  source: TaskSource;
  timestamp: string;
  message: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  source: TaskSource;
  assignee: TaskSource | null;
  context: ContextEntry[];
  result: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface TaskStore {
  version: number;
  tasks: Task[];
  last_sync: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_STORE_PATH = `${process.env.HOME || "/tmp"}/.dk-infraedge/bridge-tasks.json`;

function getStorePath(): string {
  return process.env.BRIDGE_STORE_PATH || DEFAULT_STORE_PATH;
}

// ── File Operations ────────────────────────────────────────────────────────

async function ensureDir(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

export async function loadStore(): Promise<TaskStore> {
  const storePath = getStorePath();
  try {
    const raw = await readFile(storePath, "utf-8");
    return JSON.parse(raw) as TaskStore;
  } catch {
    // Return empty store if file doesn't exist or is corrupt
    return { version: 1, tasks: [], last_sync: new Date().toISOString() };
  }
}

async function saveStore(store: TaskStore): Promise<void> {
  const storePath = getStorePath();
  await ensureDir(storePath);
  store.last_sync = new Date().toISOString();
  // Atomic write: write to temp file, then rename
  const tmpPath = `${storePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(store, null, 2), "utf-8");
  const { rename } = await import("node:fs/promises");
  await rename(tmpPath, storePath);
}

// ── CRUD Operations ────────────────────────────────────────────────────────

export async function createTask(params: {
  title: string;
  description: string;
  priority: TaskPriority;
  source: TaskSource;
  tags?: string[];
}): Promise<Task> {
  const store = await loadStore();
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID().slice(0, 8),
    title: params.title,
    description: params.description,
    status: "pending",
    priority: params.priority,
    source: params.source,
    assignee: null,
    context: [],
    result: null,
    tags: params.tags || [],
    created_at: now,
    updated_at: now,
  };
  store.tasks.push(task);
  await saveStore(store);
  return task;
}

export async function getTask(id: string): Promise<Task | null> {
  const store = await loadStore();
  return store.tasks.find((t) => t.id === id) || null;
}

export async function listTasks(filters: {
  status?: TaskStatus;
  source?: TaskSource;
  assignee?: TaskSource;
  priority?: TaskPriority;
  tag?: string;
}): Promise<Task[]> {
  const store = await loadStore();
  let tasks = store.tasks;

  if (filters.status) tasks = tasks.filter((t) => t.status === filters.status);
  if (filters.source) tasks = tasks.filter((t) => t.source === filters.source);
  if (filters.assignee) tasks = tasks.filter((t) => t.assignee === filters.assignee);
  if (filters.priority) tasks = tasks.filter((t) => t.priority === filters.priority);
  if (filters.tag) tasks = tasks.filter((t) => t.tags.includes(filters.tag!));

  // Sort: critical first, then by created_at desc
  const priorityOrder: Record<TaskPriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  tasks.sort((a, b) => {
    const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (pDiff !== 0) return pDiff;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return tasks;
}

export async function claimTask(id: string, assignee: TaskSource): Promise<Task | null> {
  const store = await loadStore();
  const task = store.tasks.find((t) => t.id === id);
  if (!task) return null;

  task.assignee = assignee;
  task.status = "in_progress";
  task.updated_at = new Date().toISOString();
  task.context.push({
    id: randomUUID().slice(0, 8),
    source: assignee,
    timestamp: task.updated_at,
    message: `Claimed by ${assignee}`,
  });
  await saveStore(store);
  return task;
}

export async function updateTask(
  id: string,
  updates: {
    status?: TaskStatus;
    priority?: TaskPriority;
    assignee?: TaskSource | null;
    title?: string;
    description?: string;
    tags?: string[];
  }
): Promise<Task | null> {
  const store = await loadStore();
  const task = store.tasks.find((t) => t.id === id);
  if (!task) return null;

  if (updates.status !== undefined) task.status = updates.status;
  if (updates.priority !== undefined) task.priority = updates.priority;
  if (updates.assignee !== undefined) task.assignee = updates.assignee;
  if (updates.title !== undefined) task.title = updates.title;
  if (updates.description !== undefined) task.description = updates.description;
  if (updates.tags !== undefined) task.tags = updates.tags;
  task.updated_at = new Date().toISOString();

  await saveStore(store);
  return task;
}

export async function completeTask(
  id: string,
  result: string,
  source: TaskSource
): Promise<Task | null> {
  const store = await loadStore();
  const task = store.tasks.find((t) => t.id === id);
  if (!task) return null;

  task.status = "completed";
  task.result = result;
  task.updated_at = new Date().toISOString();
  task.context.push({
    id: randomUUID().slice(0, 8),
    source,
    timestamp: task.updated_at,
    message: `Completed: ${result}`,
  });
  await saveStore(store);
  return task;
}

export async function addContext(
  id: string,
  source: TaskSource,
  message: string
): Promise<Task | null> {
  const store = await loadStore();
  const task = store.tasks.find((t) => t.id === id);
  if (!task) return null;

  task.context.push({
    id: randomUUID().slice(0, 8),
    source,
    timestamp: new Date().toISOString(),
    message,
  });
  task.updated_at = new Date().toISOString();
  await saveStore(store);
  return task;
}

export async function deleteTask(id: string): Promise<boolean> {
  const store = await loadStore();
  const idx = store.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  store.tasks.splice(idx, 1);
  await saveStore(store);
  return true;
}
