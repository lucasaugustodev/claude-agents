# Claude Agents

Managed Agents platform that runs Claude Code instances inside Docker containers, pre-authenticated and ready to receive tasks via a REST API with SSE streaming.

Two modes of operation:

- **Individual Agents** — 1 container per agent, full isolation
- **Groups** (recommended) — 1 container shared by N agents with a shared `/workspace` filesystem and built-in orchestrator that delegates tasks, coordinates parallel work, and synthesizes results

## How it works

### Groups (recommended)

```
Client
  |
  |  POST /groups              → Create group (1 container, N agents)
  |  POST /groups/:id/orchestrate → Send request (orchestrator delegates + synthesizes)
  v
Claude Agents API (Node.js)
  |
  |  dockerode → Docker Engine
  |  1 container for the whole group
  |  Shared /workspace filesystem
  |  Orchestrator plans → delegates to agents → synthesizes
  v
Docker Container (shared)
  |  - Node.js 20 + Claude Code CLI
  |  - 4GB RAM, shared CPU
  |  - /workspace (all agents read/write)
  |  - /publish (auto-served static files)
  |  - Dedicated port (dynamic apps)
  v
Claude API (Anthropic)
```

### Individual Agents (legacy)

```
Client → POST /agents → 1 container per agent → Claude API
```

## Authentication — How Claude Code CLI Auth Works

Claude Code does **not** use a standard API key (`sk-ant-...`). It uses an **OAuth 2.0 flow** with access + refresh tokens. Understanding this was essential to making headless/remote deployment work.

### The OAuth Flow

When you run `claude` and authenticate through the browser, the CLI stores credentials at:

```
~/.claude/.credentials.json
```

The file looks like this:

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

| Field | Description |
|-------|-------------|
| `accessToken` | Short-lived OAuth Access Token (prefix `sk-ant-oat01-`) |
| `refreshToken` | Long-lived Refresh Token (prefix `sk-ant-ort01-`) |
| `expiresAt` | Token expiry in milliseconds epoch |
| `scopes` | Authorized scopes for the token |
| `subscriptionType` | Plan type (`free`, `pro`, `max`) |

### Key Discovery: Required API Headers

The CLI hits the standard Anthropic Messages API, but requires specific headers that are **not documented**. Without all of them, the API returns `400 Bad Request`:

```
POST https://api.anthropic.com/v1/messages?beta=true

Headers:
  authorization: Bearer sk-ant-oat01-...
  anthropic-beta: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14
  anthropic-dangerous-direct-browser-access: true
  anthropic-version: 2023-06-01
  user-agent: claude-cli/<version> (external, cli)
  x-app: cli
  content-type: application/json
```

The body also requires:
- A **system** array with a billing header: `x-anthropic-billing-header: cc_version=<ver>; cc_entrypoint=cli;`
- A `metadata.user_id` field with device and account identifiers
- A `thinking` block when using the interleaved-thinking beta

### How We Use This

Instead of reverse-engineering the full API call, we use a simpler approach: **copy the credentials file** and let Claude Code CLI handle the rest. The CLI reads `~/.claude/.credentials.json`, uses the `refreshToken` to obtain new `accessToken`s when they expire, and manages the full lifecycle.

The workflow:
1. Authenticate Claude Code on the host machine (normal browser flow, one-time)
2. Read `~/.claude/.credentials.json` from host
3. Inject it into each Docker container via base64 encoding
4. Claude Code inside the container works immediately — no browser needed

This was discovered by intercepting Claude Code's HTTP calls using a Node.js `--require` interceptor. Full research: [cli-api-internals](https://github.com/lucasaugustodev/cli-api-internals).

## Setup

### Prerequisites

- Linux server (Ubuntu 22.04+)
- Docker installed
- Node.js 20+
- Claude Code authenticated on the host (`~/.claude/.credentials.json` must exist)

### Install

```bash
git clone https://github.com/lucasaugustodev/claude-agents.git
cd claude-agents

# Build the agent Docker image
docker build -t claude-agent:latest .

# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env with your API_SECRET

# Start
node server.js
```

### Systemd Service

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
RestartSec=5
Environment=PORT=3100
Environment=API_SECRET=your-secret-here
Environment=CREDENTIALS_PATH=/root/.claude/.credentials.json

[Install]
WantedBy=multi-user.target
```

## API Reference

All endpoints (except `/health`) require the `x-api-key` header.

### `GET /health`

Health check. No auth required.

```bash
curl http://localhost:3100/health
```

```json
{"status": "ok", "service": "claude-agents", "agents_count": 2, "uptime": 3600}
```

### `POST /agents`

Create a new agent. Spins up a Docker container, installs credentials, and verifies Claude Code works.

```bash
curl -X POST http://localhost:3100/agents \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret" \
  -d '{
    "name": "my-agent",
    "system_prompt": "You are a senior Python developer."
  }'
```

Response:

```json
{
  "id": "cf886e56",
  "name": "my-agent",
  "container_name": "claude-agent-cf886e56",
  "container_id": "7670c9231d...",
  "status": "ready",
  "system_prompt": "You are a senior Python developer.",
  "created_at": "2026-04-16T04:43:45.122Z",
  "tasks_completed": 0
}
```

### `GET /agents`

List all agents with Docker state.

### `GET /agents/:id`

Get details for a specific agent.

### `DELETE /agents/:id`

Stop and remove the agent's container.

```bash
curl -X DELETE http://localhost:3100/agents/cf886e56 \
  -H "x-api-key: your-secret"
```

### `POST /agents/:id/task`

Send a task to an agent. Returns **Server-Sent Events (SSE)** stream.

```bash
curl -N -X POST http://localhost:3100/agents/cf886e56/task \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret" \
  -d '{
    "prompt": "Create a REST API in Python with FastAPI that has CRUD for users",
    "max_turns": "10",
    "allowedTools": ["Bash", "Write", "Edit", "Read"]
  }'
```

**SSE Events:**

| Event | Description |
|-------|-------------|
| `task.started` | Task accepted, includes task_id |
| `task.executing` | Command being executed in container |
| `task.output` | Streaming output chunks from Claude |
| `task.completed` | Task finished, includes full output |
| `task.error` | Error occurred |

**Body parameters:**

| Field | Required | Description |
|-------|----------|-------------|
| `prompt` | Yes | The task/prompt to send |
| `system_prompt` | No | Override agent's system prompt |
| `model` | No | Claude model to use |
| `max_turns` | No | Max agentic turns |
| `allowedTools` | No | Array of allowed tools (e.g. `["Bash", "Write"]`) |

### `POST /agents/:id/conversation`

Multi-turn conversation using Claude Code's `--resume` flag.

```bash
curl -N -X POST http://localhost:3100/agents/cf886e56/conversation \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret" \
  -d '{
    "prompt": "What files did you create in the last task?",
    "session_id": "previous-session-id"
  }'
```

### `POST /agents/:id/exec`

Run a raw shell command inside the agent's container.

```bash
curl -X POST http://localhost:3100/agents/cf886e56/exec \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret" \
  -d '{"command": "ls -la /workspace"}'
```

### `POST /agents/:id/upload`

Upload a file to the agent's container.

```bash
curl -X POST http://localhost:3100/agents/cf886e56/upload \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret" \
  -d '{
    "path": "/workspace/config.json",
    "content": "{\"key\": \"value\"}"
  }'
```

## Groups API Reference

### `POST /groups`

Create a group — 1 Docker container with N agents sharing `/workspace`.

```bash
curl -X POST http://localhost:3100/groups \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret" \
  -d '{
    "name": "web-team",
    "description": "Frontend + Backend team",
    "members": [
      {"name": "frontend", "role": "Frontend Developer", "system_prompt": "You are a frontend expert."},
      {"name": "backend", "role": "Backend Developer", "system_prompt": "You are a Node.js expert."}
    ]
  }'
```

Response includes `publish_url`, `dynamic_url`, and `production_url` (subdomain).

### `POST /groups/:id/orchestrate`

Send a request to the group. The orchestrator analyzes, delegates to agents in parallel, and synthesizes results. Returns SSE stream.

```bash
curl -N -X POST http://localhost:3100/groups/abc123/orchestrate \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret" \
  -d '{"prompt": "Create a landing page with a REST API backend"}'
```

**SSE Events:**

| Event | Description |
|-------|-------------|
| `orchestrate.started` | Request received |
| `orchestrate.planning` | Orchestrator analyzing and planning (streaming) |
| `orchestrate.plan_ready` | Plan complete, includes DELEGATE block |
| `orchestrate.delegating` | Tasks being dispatched to agents |
| `agent.started` | Agent began working on task |
| `agent.output` | Streaming output from agent |
| `agent.completed` | Agent finished task |
| `orchestrate.synthesis` | Orchestrator synthesizing results |
| `orchestrate.completed` | All done, includes full synthesis |
| `schedule.created` | Recurring schedule detected and created |

### `POST /groups/:id/task`

Send a task to a specific agent in the group (bypasses orchestrator).

```bash
curl -N -X POST http://localhost:3100/groups/abc123/task \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret" \
  -d '{"agent_name": "frontend", "prompt": "Add a dark mode toggle"}'
```

### `POST /groups/:id/members`

Add a new member to an existing group.

### `DELETE /groups/:id/members/:name`

Remove a member from a group.

### `GET /groups` | `GET /groups/:id` | `DELETE /groups/:id`

List, get details, or destroy a group.

## Publishing & Deploy

Every agent (individual or in a group) gets three ways to publish:

| Method | How | URL |
|--------|-----|-----|
| **Static** | Save to `/publish/` | `http://HOST:PORT/sites/{id}/` |
| **Dynamic** | Start server on dedicated port | `http://HOST:{port}/` |
| **Production** | Register subdomain via Container Manager | `https://{name}.agentsfy.cc` |

Agents are taught these capabilities via injected system prompts — they publish automatically when asked.

## Container Specs

| Resource | Individual Agent | Group |
|----------|-----------------|-------|
| Memory | 2 GB | 4 GB |
| CPU Shares | 512 | 1024 |
| Base Image | `node:20-slim` | `node:20-slim` |
| Installed | Claude Code CLI, git, curl | Same |
| Filesystem | `/workspace` (isolated) | `/workspace` (shared by all agents) |
| Publish | `/publish` (volume mount) | `/publish` (volume mount) |

## Recovery

On startup, the API scans Docker for containers with `claude-agents=true` or `claude-groups=true` labels and re-registers them.

## License

MIT
