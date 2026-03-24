# DK Bridge MCP Server v2.0 — Setup Guide

## What's New in v2.0
- **Webhook notifications** — automatic HTTP POST on task.created, task.completed, task.blocked, task.claimed, task.updated
- **Slack integration** — formatted Slack messages with priority emojis and task details
- **HMAC signing** — optional webhook payload verification
- **Bridge watcher daemon** — systemd service that monitors for new tasks and sends notifications
- **Claude Code auto-spawn** — optionally launch Claude Code sessions for HIGH/CRITICAL tasks

## Quick Setup

### 1. Replace the existing bridge server

```bash
# Backup existing server
cp -r ~/servers/dk-bridge-mcp-server ~/servers/dk-bridge-mcp-server.bak

# Copy new server
cp -r ./dk-bridge-mcp-server ~/servers/ # or wherever your plugin root is

# Build
cd ~/servers/dk-bridge-mcp-server
npm install && npm run build
```

The existing `bridge-tasks.json` is fully compatible — v2 adds a `webhooks` array that gets auto-created on first use.

### 2. Register a webhook (from Cowork or Claude Code)

```
# In any Claude session with the bridge MCP:
bridge_add_webhook(
  url: "https://hooks.slack.com/services/YOUR/WEBHOOK/URL",
  events: ["task.created", "task.completed", "task.blocked"]
)

# Test it:
bridge_test_webhook(url: "https://hooks.slack.com/services/YOUR/WEBHOOK/URL")
```

### 3. Install the watcher daemon (on P620)

```bash
# Copy service file
sudo cp watcher/dk-bridge-watcher.service /etc/systemd/system/

# Edit paths and env vars to match your setup
sudo systemctl edit dk-bridge-watcher.service

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable dk-bridge-watcher
sudo systemctl start dk-bridge-watcher

# Check status
sudo systemctl status dk-bridge-watcher
journalctl -u dk-bridge-watcher -f
```

### 4. (Optional) Enable Claude Code auto-spawn

Uncomment in the systemd service file:
```
Environment=CLAUDE_CODE_AUTO=true
Environment=CLAUDE_CODE_PROJECT=/home/echezona/projects/dk-infraedge
```

This will automatically launch a Claude Code session when a HIGH or CRITICAL task is created. The session starts with the task context and runs `bridge_list_tasks` to see the full queue.

## Architecture

```
Cowork                          P620 (homelab)
  │                               │
  ├─ bridge_create_task() ──────► bridge-tasks.json ◄── bridge_create_task() ─── Claude Code
  │       │                       │         │                                        │
  │       └─ fires webhook ──►  Slack    watcher daemon                              │
  │                               │         │                                        │
  │                               │         ├─ Desktop notification                  │
  │                               │         ├─ Slack notification                    │
  │                               │         └─ (optional) spawn Claude Code ────►    │
  │                               │                                                  │
  └─ bridge_list_tasks() ──────► bridge-tasks.json ◄── bridge_list_tasks() ─────────┘
```

Both the webhook (from MCP server) and the watcher (systemd daemon) can send notifications. Use webhooks for the MCP-side fires (instant, but only when a tool is called). Use the watcher for file-change detection (catches tasks created by either environment).

## Notification Channels

| Channel | Config | Latency | Notes |
|---------|--------|---------|-------|
| Webhook (Slack) | `bridge_add_webhook` | Instant | Fires from MCP tool call |
| Watcher → Slack | `SLACK_WEBHOOK_URL` env | ~5s poll | Catches file changes |
| Watcher → Desktop | `DESKTOP_NOTIFY=true` | ~5s poll | Linux notify-send |
| Watcher → Claude Code | `CLAUDE_CODE_AUTO=true` | ~5s poll | Auto-spawns sessions |
