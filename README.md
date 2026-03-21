# DK Bridge MCP Server

Shared task queue bridging **Cowork** and **Claude Code** via MCP tools. Both environments read/write the same JSON file, enabling asynchronous task handoff between them.

## How It Works

```
┌─────────────┐     ┌──────────────────────┐     ┌──────────────┐
│   Cowork     │────▶│  bridge-tasks.json   │◀────│  Claude Code  │
│  (MCP stdio) │     │  ~/.dk-infraedge/    │     │  (MCP stdio)  │
└─────────────┘     └──────────────────────┘     └──────────────┘
```

Both environments connect to their own instance of the MCP server. The server reads/writes a shared JSON file on disk — no database, no network, no conflicts.

## Tools (9 total)

| Tool | Description |
|------|-------------|
| `bridge_create_task` | Create a new task with title, description, priority, tags |
| `bridge_list_tasks` | List/filter tasks by status, source, assignee, priority, tag |
| `bridge_get_task` | Get full task detail with context thread |
| `bridge_claim_task` | Claim a task (sets assignee + in_progress) |
| `bridge_update_task` | Update fields (status, priority, title, etc.) |
| `bridge_complete_task` | Mark done with result summary |
| `bridge_add_context` | Add notes/progress/questions to a task's thread |
| `bridge_delete_task` | Permanently remove a task |
| `bridge_dashboard` | Overview dashboard with counts and highlights |

## Setup

### 1. Install and Build

```bash
cd ~/Downloads/dk-bridge-mcp-server
npm install
npm run build
```

### 2. Configure in Claude Code

Add to `~/.claude/claude_code_config.json` (or project-level `.mcp.json`):

```json
{
  "mcpServers": {
    "dk-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/dk-bridge-mcp-server/dist/index.js"],
      "env": {}
    }
  }
}
```

### 3. Configure in Cowork

Install as a local MCP connector in the Cowork desktop app settings, or add to the Claude desktop config:

```json
{
  "mcpServers": {
    "dk-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/dk-bridge-mcp-server/dist/index.js"],
      "env": {}
    }
  }
}
```

### 4. (Optional) Custom Store Path

Set `BRIDGE_STORE_PATH` env var to use a different file location:

```json
{
  "env": {
    "BRIDGE_STORE_PATH": "/path/to/custom/bridge-tasks.json"
  }
}
```

Default: `~/.dk-infraedge/bridge-tasks.json`

## Usage Examples

### Cowork creates a task for Claude Code:
> "Create a bridge task for Claude Code to deploy alpaca-trader to k3s with high priority"

### Claude Code picks it up:
> "List bridge tasks assigned to me" → "Claim task abc123"

### Claude Code reports progress:
> "Add context to task abc123: Docker build complete, running tests"

### Claude Code completes it:
> "Complete task abc123 with result: Deployed to k3s, 3 pods healthy"

### Either side checks status:
> "Show the bridge dashboard"

## Architecture

- **Transport**: stdio (each environment spawns its own server process)
- **Storage**: Single JSON file with atomic writes (write tmp → rename)
- **No conflicts**: File-level atomicity is sufficient for 2-client usage
- **No deps**: Only `@modelcontextprotocol/sdk` and `zod`
