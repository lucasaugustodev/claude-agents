# Claude Agents

Managed Agents platform for orchestrating Claude Code instances inside Docker containers. Pre-authenticated, tool-calling via MCP, with a REST API and SSE streaming.

Built for the [Agentsfy](https://agentsfy.cc) platform.

## Architecture

```
┌─ claude-agents API (Node, port 8200) ───────────────────────┐
│  + MCP callback server (port 8201)                          │
│  + Tool registry (delegate_agent, ask_user, finish)         │
└────┬──────────────────────────────────────────────────────┬─┘
     │                                                      │
     │ dockerode                                     HTTP callback
     ▼                                                      ▲
┌─ Docker Container (1 per group) ────────────────────────────┐
│  Runs as non-root user `agent` (uid 1001)                   │
│  ┌─ Orchestrator (claude -p --bare --mcp-config ...) ─┐     │
│  │   Tool-calls delegate_agent(member, task) via MCP  │     │
│  │   Loops until finish() or end_turn                 │     │
│  └────────────────────────────────────────────────────┘     │
│  ┌─ MCP stdio server (node /opt/mcp/mcp-server.js) ──┐      │
│  │   Spawned by Claude CLI via --mcp-config          │      │
│  │   Forwards tool calls via HTTP to backend         │      │
│  └───────────────────────────────────────────────────┘      │
│  ┌─ Subagents (spawned on delegate_agent via exec) ─┐       │
│  │   claude -p --bare with each member's prompt     │       │
│  │   Share /workspace filesystem                    │       │
│  └──────────────────────────────────────────────────┘       │
│  /workspace  — shared filesystem across all agents          │
│  /publish    — auto-served static files                     │
│  /workspace/shared/context.json     — api_url, api_token    │
│  /workspace/shared/credentials.json — user API secrets      │
└─────────────────────────────────────────────────────────────┘
```

## Key Design

### Tool-calling via MCP (no regex)

The orchestrator does not output `DELEGATE:` blocks. It invokes real tools through the Model Context Protocol:

| Tool | Description |
|------|-------------|
| `delegate_agent(agent_name, task)` | Run a team member, return their output |
| `ask_user(question)` | Ask the user a question and signal end-of-turn |
| `finish(summary)` | Mark orchestration complete |

Claude CLI natively understands these via `--mcp-config`. The MCP stdio server runs inside the container and forwards each tool call to the backend over HTTP, which spawns the requested subagent and streams its output back.

### `--bare` mode for speed

All Claude CLI calls use `--bare`, which skips hooks, plugins, LSP, CLAUDE.md discovery, and auto-memory. Combined with exporting the OAuth token as `ANTHROPIC_API_KEY`, cold start drops from ~4.7s to ~1.8s.

**Measured end-to-end latency:**

| Flow | Before | After |
|------|--------|-------|
| Cold start | 4.7s | **1.8s** |
| Simple delegation (orchestrator + 1 subagent) | 60-120s | **~20s** |
| Sequential 2-agent flow | 150-240s | **~40s** |

### Stream-json parsing

Claude CLI runs with `--output-format stream-json --verbose`. We parse the stream in real time:

- `assistant` blocks → `text` chunks (streamed to user) and `tool_use` blocks (emitted as events)
- `user` blocks with `tool_result` → emitted as events
- `result` block → authoritative final text

The final text from `result` is preferred over concatenating streamed chunks (which can duplicate when Claude emits multiple assistant turns).

### Retry with exponential backoff

`containerExecStreamWithRetry` detects `API Error: 500`, `529`, `overloaded`, `rate_limit`, and retries 3 times with 10s/20s/30s backoff. Notifies the user that a retry is in progress.

## Authentication — Claude Code CLI OAuth

Claude Code does **not** use standard API keys. It uses OAuth with access + refresh tokens stored at `~/.claude/.credentials.json`:

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1776341693403,
    "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
    "subscriptionType": "max"
  }
}
```

To inject these credentials into every container, we copy the host's credentials file on container startup, placed at `/home/agent/.claude/.credentials.json`. Claude CLI reads them and uses the `refreshToken` to obtain fresh `accessToken`s as they expire.

**Trick to use `--bare`:** `--bare` mode requires `ANTHROPIC_API_KEY` instead of reading the OAuth file. Since `sk-ant-oat01-*` tokens are accepted by the Messages API, we export the `accessToken` as `ANTHROPIC_API_KEY` at runtime:

```bash
export ANTHROPIC_API_KEY="$(jq -r .claudeAiOauth.accessToken /home/agent/.claude/.credentials.json)"
claude -p --bare ...
```

Full research on the internal API: [cli-api-internals](https://github.com/lucasaugustodev/cli-api-internals).

## Setup

### Prerequisites

- Linux server (Ubuntu 22.04+)
- Docker
- Node.js 20+
- Claude Code authenticated on host (`~/.claude/.credentials.json`)

### Install

```bash
git clone https://github.com/lucasaugustodev/claude-agents.git
cd claude-agents

# Build the Docker image
docker build -t claude-agent:latest .

# Allow containers to reach host services through docker0 bridge
sudo ./setup-iptables.sh

# Install deps
npm install

# Configure
cp .env.example .env
# edit API_SECRET, CREDENTIALS_PATH

# Run
node server.js
```

### Systemd

```ini
[Unit]
Description=Claude Code Managed Agents API
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/claude-agents
ExecStart=/usr/bin/node /opt/claude-agents/server.js
Restart=always
Environment=PORT=8200
Environment=MCP_CALLBACK_PORT=8201
Environment=API_SECRET=your-secret-here
Environment=CREDENTIALS_PATH=/root/.claude/.credentials.json
Environment=MCP_HOST_FROM_CONTAINER=172.17.0.1
Environment=DEFAULT_MODEL=claude-opus-4-7

[Install]
WantedBy=multi-user.target
```

### iptables

Containers need to reach host services over the docker0 bridge:

```bash
iptables -I INPUT -i docker0 -p tcp --dport 4001 -j ACCEPT  # Agentify API
iptables -I INPUT -i docker0 -p tcp --dport 8201 -j ACCEPT  # MCP callback
iptables -I INPUT -i docker0 -p tcp --dport 8100 -j ACCEPT  # MemPalace
iptables -I INPUT -i docker0 -p tcp --dport 9090 -j ACCEPT  # Container Manager
```

Use `setup-iptables.sh` in the repo.

## Groups API

### `POST /groups`

Create a group — 1 Docker container, N agents, shared `/workspace`.

```bash
curl -X POST http://localhost:8200/groups \
  -H "x-api-key: your-secret" \
  -d '{
    "name": "web-team",
    "members": [
      {"name": "Writer", "role": "writer", "system_prompt": "You write things."},
      {"name": "Reviewer", "role": "reviewer", "system_prompt": "You review things."}
    ]
  }'
```

Response includes `port`, `subdomain`, `publish_url`, `dynamic_url`, `production_url`.

### `POST /groups/:id/orchestrate`

Send a request to the group. Returns SSE stream.

```bash
curl -N -X POST http://localhost:8200/groups/abc123/orchestrate \
  -H "x-api-key: your-secret" \
  -d '{
    "prompt": "Writer writes a poem about rain, then Reviewer reads it and gives feedback",
    "user_id": "uuid-of-user"
  }'
```

**SSE events:**

| Event | When |
|-------|------|
| `orchestrate.started` | Request accepted |
| `orchestrate.message` | Orchestrator sends a status message |
| `orchestrator.tool_use` | Orchestrator invoked a tool (delegate_agent, finish, curl, etc) |
| `orchestrator.tool_result` | Tool returned |
| `orchestrator.question` | `ask_user` invoked |
| `agent.started` | Subagent began work |
| `agent.tool_use` | Subagent used a tool |
| `agent.output` | Subagent streaming text |
| `agent.completed` | Subagent finished |
| `agent.error` | Subagent errored |
| `orchestrate.completed` | Full run done |

### Other endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/groups` | List all groups |
| GET | `/groups/:id` | Get group details |
| DELETE | `/groups/:id` | Destroy a group |
| POST | `/groups/:id/task` | Task a specific agent (bypasses orchestrator) |
| POST | `/groups/:id/exec` | Run a shell command in the container |
| POST | `/groups/:id/members` | Add a member |
| DELETE | `/groups/:id/members/:name` | Remove a member |

## Memory — 3 Scopes

Memory is backed by MemPalace (ChromaDB) with 3 tenant types:

| Scope | Tenant | Purpose |
|-------|--------|---------|
| User | `user/{userId}` | Personal preferences across all groups |
| Group | `group/{groupId}` | Shared project context within a group |
| Agent | `agent/{agentName}` | Per-agent learnings and preferences |

Memory is auto-injected into every system prompt before a task runs, and auto-saved after each task completes.

Agents can also invoke `memory_search` and `memory_store` tools via the platform API.

## Platform Tools

The MCP orchestrator exposes tools from the Agentify backend via `/api/tools/:name` (HTTP, not MCP). Agents invoke them with curl:

```bash
API_URL=$(jq -r .api_url /workspace/shared/context.json)
API_TOKEN=$(jq -r .api_token /workspace/shared/context.json)
CONV_ID=$(jq -r .conversation_id /workspace/shared/context.json)

curl -X POST "$API_URL/api/tools/schedule_create" \
  -H "x-api-token: $API_TOKEN" \
  -d '{"conversation_id":"'$CONV_ID'","cron":"*/10 * * * *","name":"News","prompt":"Fetch news"}'
```

Available platform tools:

- `schedule_create` / `schedule_list` / `schedule_delete` — recurring tasks
- `deploy_app` — publish app to production subdomain
- `credential_get` — fetch user secrets (never hardcode)
- `memory_search` / `memory_store` — persistent memory
- `project_file_read` / `project_file_write` — user's cloud container
- `github_create_repo` — GitHub operations

## Publishing & Deploy

Every group gets three ways to publish:

| Method | How | URL |
|--------|-----|-----|
| Static | Save to `/publish/` | `http://HOST:8200/sites/{id}/` |
| Dynamic | Server on dedicated port | `http://HOST:{port}/` |
| Production | Register subdomain via Container Manager | `https://{name}.agentsfy.cc` |

The Agentify backend auto-registers subdomain + app after a successful orchestration when `/publish` has content.

## Container Specs

| Resource | Group |
|----------|-------|
| Memory | 4 GB |
| CPU Shares | 1024 |
| Base | `node:20-slim` |
| User | `agent` (uid 1001) — required for `bypassPermissions` mode |
| Installed | Claude Code CLI, node, jq, git, curl, sudo |
| MCP Server | `/opt/mcp/mcp-server.js` (loaded by `claude --mcp-config`) |
| Shared | `/workspace` (all agents), `/publish` (auto-served) |

## Recovery

On startup, the API scans Docker for containers labeled `claude-groups=true` or `claude-agents=true` and re-registers them in memory. Running orchestrations are not preserved across restarts.

## License

MIT
