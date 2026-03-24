#!/usr/bin/env node

/**
 * DK Bridge Watcher Daemon
 *
 * Watches ~/.dk-infraedge/bridge-tasks.json for new tasks and fires
 * notifications. Designed to run as a systemd service on the P620.
 *
 * Notification channels (configurable via env vars):
 *   - SLACK_WEBHOOK_URL: Slack incoming webhook
 *   - DESKTOP_NOTIFY: "true" to send desktop notifications via notify-send
 *   - CLAUDE_CODE_AUTO: "true" to auto-spawn Claude Code for HIGH/CRITICAL tasks
 *   - CLAUDE_CODE_PROJECT: path to project dir for Claude Code sessions
 *
 * Usage:
 *   SLACK_WEBHOOK_URL=https://hooks.slack.com/... node bridge-watcher.js
 *   DESKTOP_NOTIFY=true node bridge-watcher.js
 */

import { readFileSync, watchFile, existsSync, createWriteStream } from "node:fs";
import { execSync, spawn } from "node:child_process";

const STORE_PATH =
  process.env.BRIDGE_STORE_PATH ||
  `${process.env.HOME}/.dk-infraedge/bridge-tasks.json`;

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "5000", 10); // 5s default
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const DESKTOP_NOTIFY = process.env.DESKTOP_NOTIFY === "true";
const CLAUDE_CODE_AUTO = process.env.CLAUDE_CODE_AUTO === "true";
const CLAUDE_CODE_PROJECT = process.env.CLAUDE_CODE_PROJECT || "";

let knownTaskIds = new Set();
let lastMtime = 0;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function loadTasks() {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const raw = readFileSync(STORE_PATH, "utf-8");
    const data = JSON.parse(raw);
    return data.tasks || [];
  } catch (err) {
    log(`Error reading store: ${err.message}`);
    return [];
  }
}

function initKnownTasks() {
  const tasks = loadTasks();
  for (const task of tasks) {
    knownTaskIds.add(task.id);
  }
  log(`Initialized with ${knownTaskIds.size} known tasks`);
}

async function sendSlack(task) {
  if (!SLACK_WEBHOOK_URL) return;

  const priorityEmoji = {
    critical: ":rotating_light:",
    high: ":red_circle:",
    medium: ":large_yellow_circle:",
    low: ":white_circle:",
  };

  const emoji = priorityEmoji[task.priority] || ":memo:";

  const payload = {
    text: `${emoji} New Bridge Task: ${task.title} [${task.priority}]`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `New Bridge Task: ${task.title}`,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Priority:* ${emoji} ${task.priority}`,
          },
          { type: "mrkdwn", text: `*Source:* ${task.source}` },
          { type: "mrkdwn", text: `*ID:* \`${task.id}\`` },
          { type: "mrkdwn", text: `*Tags:* ${task.tags?.join(", ") || "none"}` },
        ],
      },
    ],
  };

  if (task.description) {
    payload.blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: task.description.substring(0, 500),
      },
    });
  }

  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      log(`Slack notification sent for task ${task.id}`);
    } else {
      log(`Slack failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    log(`Slack error: ${err.message}`);
  }
}

function sendDesktopNotify(task) {
  if (!DESKTOP_NOTIFY) return;

  const urgency =
    task.priority === "critical" || task.priority === "high"
      ? "critical"
      : "normal";

  try {
    execSync(
      `notify-send --urgency=${urgency} "DK Bridge: ${task.priority.toUpperCase()}" "${task.title}" --icon=dialog-information`,
      { timeout: 5000 }
    );
    log(`Desktop notification sent for task ${task.id}`);
  } catch (err) {
    log(`Desktop notify error: ${err.message}`);
  }
}

const CLAUDE_BIN =
  process.env.CLAUDE_BIN ||
  `${process.env.HOME}/.nvm/versions/node/v20.20.1/bin/claude`;

function spawnClaudeCode(task) {
  if (!CLAUDE_CODE_AUTO) return;
  if (task.priority !== "critical" && task.priority !== "high") return;
  if (!CLAUDE_CODE_PROJECT) {
    log(`CLAUDE_CODE_AUTO is true but CLAUDE_CODE_PROJECT not set — skipping`);
    return;
  }

  const prompt = `Bridge task ${task.id} (${task.priority}): ${task.title}\n\n${task.description}\n\nCheck the dk-bridge task queue and execute this task.`;

  try {
    const logFile = `/tmp/claude-bridge-${task.id}.log`;

    const child = spawn(CLAUDE_BIN, [
      "--dangerously-skip-permissions",
      "--print",
      prompt,
    ], {
      cwd: CLAUDE_CODE_PROJECT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.nvm/versions/node/v20.20.1/bin:${process.env.PATH || ""}`,
      },
    });

    const out = createWriteStream(logFile);
    child.stdout.pipe(out);
    child.stderr.pipe(out);

    child.unref();
    log(`Spawned Claude Code session for task ${task.id} (PID=${child.pid}, log=${logFile})`);
  } catch (err) {
    log(`Claude Code spawn error: ${err.message}`);
  }
}

async function checkForNewTasks() {
  const tasks = loadTasks();
  const newTasks = tasks.filter(
    (t) => !knownTaskIds.has(t.id) && t.status === "pending"
  );

  for (const task of newTasks) {
    knownTaskIds.add(task.id);
    log(`New task detected: [${task.id}] ${task.priority.toUpperCase()} — ${task.title}`);

    // Fire all configured notification channels
    await sendSlack(task);
    sendDesktopNotify(task);
    spawnClaudeCode(task);
  }

  // Also detect status changes to blocked
  for (const task of tasks) {
    if (task.status === "blocked" && !knownTaskIds.has(`blocked:${task.id}`)) {
      knownTaskIds.add(`blocked:${task.id}`);
      log(`Task blocked: [${task.id}] ${task.title}`);
      if (SLACK_WEBHOOK_URL) {
        await sendSlack({ ...task, title: `BLOCKED: ${task.title}` });
      }
      sendDesktopNotify({ ...task, title: `BLOCKED: ${task.title}` });
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────
log("DK Bridge Watcher starting...");
log(`Store: ${STORE_PATH}`);
log(`Poll interval: ${POLL_INTERVAL}ms`);
log(`Slack: ${SLACK_WEBHOOK_URL ? "Configured" : "Not configured"}`);
log(`Desktop notifications: ${DESKTOP_NOTIFY ? "Enabled" : "Disabled"}`);
log(`Claude Code auto-spawn: ${CLAUDE_CODE_AUTO ? "Enabled" : "Disabled"}`);

initKnownTasks();

// Use both file watch and polling for reliability
watchFile(STORE_PATH, { interval: POLL_INTERVAL }, () => {
  checkForNewTasks().catch((err) => log(`Check error: ${err.message}`));
});

// Initial check
checkForNewTasks().catch((err) => log(`Initial check error: ${err.message}`));

// Keep alive
process.on("SIGTERM", () => {
  log("Received SIGTERM, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  log("Received SIGINT, shutting down...");
  process.exit(0);
});
