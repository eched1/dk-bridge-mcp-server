import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { BridgeStore, Task, WebhookConfig } from "../types.js";

const STORE_PATH = process.env.BRIDGE_STORE_PATH || `${process.env.HOME}/.dk-infraedge/bridge-tasks.json`;
const BACKUP_PATH = STORE_PATH + ".bak";
const TMP_PATH = STORE_PATH + ".tmp";

function ensureStoreDir(): void {
  const dir = dirname(STORE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function defaultStore(): BridgeStore {
  return { tasks: [], webhooks: [], lastSync: new Date().toISOString() };
}

function parseStore(raw: string): BridgeStore {
  const data = JSON.parse(raw);
  if (!Array.isArray(data.tasks)) throw new Error("Invalid store: missing tasks array");
  if (!data.webhooks) data.webhooks = [];
  return data as BridgeStore;
}

export function loadStore(): BridgeStore {
  ensureStoreDir();
  if (!existsSync(STORE_PATH)) {
    // Try backup before creating empty store
    if (existsSync(BACKUP_PATH)) {
      try {
        const raw = readFileSync(BACKUP_PATH, "utf-8");
        const store = parseStore(raw);
        console.error(`[bridge-store] Primary missing, recovered ${store.tasks.length} tasks from backup`);
        saveStore(store);
        return store;
      } catch (e) {
        console.error("[bridge-store] Backup also corrupt, creating new store:", e);
      }
    }
    const store = defaultStore();
    saveStore(store);
    return store;
  }
  try {
    const raw = readFileSync(STORE_PATH, "utf-8");
    return parseStore(raw);
  } catch (e) {
    console.error("[bridge-store] Failed to parse primary store:", e);
    // Try backup before returning empty
    if (existsSync(BACKUP_PATH)) {
      try {
        const raw = readFileSync(BACKUP_PATH, "utf-8");
        const store = parseStore(raw);
        console.error(`[bridge-store] Recovered ${store.tasks.length} tasks from backup`);
        saveStore(store);
        return store;
      } catch (e2) {
        console.error("[bridge-store] Backup also corrupt:", e2);
      }
    }
    return defaultStore();
  }
}

export function saveStore(store: BridgeStore): void {
  ensureStoreDir();
  store.lastSync = new Date().toISOString();
  const json = JSON.stringify(store, null, 2);
  // Backup existing file before overwrite
  if (existsSync(STORE_PATH)) {
    try {
      copyFileSync(STORE_PATH, BACKUP_PATH);
    } catch (e) {
      console.error("[bridge-store] Failed to create backup:", e);
    }
  }
  // Atomic write: tmp file + rename
  writeFileSync(TMP_PATH, json, "utf-8");
  renameSync(TMP_PATH, STORE_PATH);
}

export function generateId(): string {
  return randomBytes(4).toString("hex");
}

export function findTask(store: BridgeStore, id: string): Task | undefined {
  return store.tasks.find((t) => t.id === id || t.id.startsWith(id));
}

export function formatTask(task: Task): string {
  const lines: string[] = [
    `## [${task.id}] ${task.title}`,
    `**Status**: ${task.status} | **Priority**: ${task.priority} | **Source**: ${task.source}`,
  ];
  if (task.tags.length > 0) {
    lines.push(`**Tags**: ${task.tags.join(", ")}`);
  }
  if (task.description) {
    lines.push("", task.description);
  }
  if (task.result) {
    lines.push("", `**Result**: ${task.result}`);
  }
  if (task.context.length > 0) {
    lines.push("", `### Context (${task.context.length} entries)`);
    for (const c of task.context) {
      lines.push(`- **${c.source}** (${c.timestamp}): ${c.message}`);
    }
  }
  lines.push("", `*Created*: ${task.createdAt} | *Updated*: ${task.updatedAt}`);
  return lines.join("\n");
}

export function getWebhooks(store: BridgeStore): WebhookConfig[] {
  return store.webhooks || [];
}

export function addWebhook(store: BridgeStore, webhook: WebhookConfig): void {
  if (!store.webhooks) store.webhooks = [];
  store.webhooks.push(webhook);
}

export function removeWebhook(store: BridgeStore, url: string): boolean {
  if (!store.webhooks) return false;
  const before = store.webhooks.length;
  store.webhooks = store.webhooks.filter((w) => w.url !== url);
  return store.webhooks.length < before;
}
