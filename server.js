const express = require("express");
const Docker = require("dockerode");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const PORT = process.env.PORT || 3100;
const API_SECRET = process.env.API_SECRET || "claude-agents-secret-2026";
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH || "/root/.claude/.credentials.json";
const HOST_IP = process.env.HOST_IP || "0.0.0.0";
const DEPLOYS_DIR = process.env.DEPLOYS_DIR || "/opt/deploys";
const CLOUD_API_URL = process.env.CLOUD_API_URL || "http://127.0.0.1:9090";
const CLOUD_API_SECRET = process.env.CLOUD_API_SECRET || "agentify-cloud-secret-2026";
const DOMAIN = process.env.DOMAIN || "agentsfy.cc";
const MEMPALACE_URL = process.env.MEMPALACE_URL || "http://127.0.0.1:8100";
const IMAGE_NAME = "claude-agent:latest";
const CONTAINER_PREFIX = "claude-agent-";
const GROUP_PREFIX = "claude-group-";
const PORT_RANGE_START = 9000;
const PORT_RANGE_END = 9999;

// ============================================================
//  MEMORY SYSTEM — 3 scopes: agent, group, user
// ============================================================

async function mempalaceFetch(path, body) {
  try {
    const res = await fetch(MEMPALACE_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    console.error("MemPalace error:", err.message);
    return null;
  }
}

async function storeMemory(tenantType, tenantId, content, wing, room, tags) {
  return mempalaceFetch("/api/memories", {
    tenant_type: tenantType,
    tenant_id: tenantId,
    content,
    wing: wing || "general",
    room: room || "auto",
    tags: tags || [],
  });
}

async function searchMemory(tenantType, tenantId, query, limit) {
  return mempalaceFetch("/api/memories/search", {
    tenant_type: tenantType,
    tenant_id: tenantId,
    query,
    n_results: limit || 5,
  });
}

async function searchMultiMemory(tenants, query, limit) {
  return mempalaceFetch("/api/memories/search-multi", {
    tenants,
    query,
    limit: limit || 5,
  });
}

// Fetch all relevant memories for a task (3 scopes merged)
async function getMemoryContext(agentName, groupId, userId, prompt) {
  const tenants = [];
  if (agentName) tenants.push({ type: "agent", id: agentName });
  if (groupId) tenants.push({ type: "group", id: groupId });
  if (userId) tenants.push({ type: "user", id: userId });

  if (tenants.length === 0 || !prompt) return "";

  const result = await searchMultiMemory(tenants, prompt, 8);
  if (!result || !result.results || result.results.length === 0) {
    console.log("[Memory] No results for query:", prompt.slice(0, 50));
    return "";
  }

  console.log("[Memory] Got " + result.results.length + " results, filtering by similarity >= 0.15");
  const memories = result.results
    .filter(r => (r.similarity || r.score || 0) >= 0.15)
    .map(r => "- [" + r.tenant_type + "/" + r.wing + "] " + (r.text || r.content))
    .join("\n");

  if (!memories) return "";
  return "\n\n[RELEVANT MEMORIES from previous interactions]\n" + memories + "\n[END MEMORIES]\n";
}

// Auto-save key output as memory after task completion
async function autoSaveMemory(agentName, groupId, userId, prompt, output) {
  if (!output || output.length < 80) return;

  // Save to agent scope
  if (agentName) {
    const summary = output.length > 500 ? output.slice(0, 500) + "..." : output;
    await storeMemory("agent", agentName, "Task: " + prompt.slice(0, 100) + "\nResult: " + summary, "tasks", "auto", []);
  }

  // Save to group scope
  if (groupId) {
    const summary = output.length > 500 ? output.slice(0, 500) + "..." : output;
    await storeMemory("group", groupId, "[" + (agentName || "agent") + "] " + prompt.slice(0, 100) + " → " + summary, "activity", "auto", []);
  }
}

// In-memory registries
const agents = new Map();
const groups = new Map();
const allocatedPorts = new Set();

function getHostIp() {
  if (HOST_IP !== "0.0.0.0") return HOST_IP;
  try { return require("os").networkInterfaces().eth0?.[0]?.address || "localhost"; } catch { return "localhost"; }
}

// --- Port allocation ---
function allocatePort() {
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!allocatedPorts.has(p)) {
      allocatedPorts.add(p);
      return p;
    }
  }
  throw new Error("No available ports in range " + PORT_RANGE_START + "-" + PORT_RANGE_END);
}

function allocatePorts(n) {
  const ports = [];
  for (let i = 0; i < n; i++) ports.push(allocatePort());
  return ports;
}

function releasePort(port) { allocatedPorts.delete(port); }

// --- Ensure dirs ---
try { fs.mkdirSync(DEPLOYS_DIR, { recursive: true }); } catch (_) {}

// --- Static file serving ---
app.use("/sites", express.static(DEPLOYS_DIR));

// --- Auth middleware ---
function auth(req, res, next) {
  if (req.headers["x-api-key"] !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// --- Docker exec helpers ---
async function containerExec(container, command) {
  const exec = await container.exec({ Cmd: ["bash", "-c", command], AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false });
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => { chunks.push(chunk.length > 8 ? chunk.slice(8) : chunk); });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

async function containerExecStream(container, command, onData) {
  const exec = await container.exec({ Cmd: ["bash", "-c", command], AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false });
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => {
      const text = (chunk.length > 8 ? chunk.slice(8) : chunk).toString("utf8");
      chunks.push(text);
      if (onData) onData(text);
    });
    stream.on("end", () => resolve(chunks.join("")));
    stream.on("error", reject);
  });
}

// --- Retry wrapper for Claude Code execution (retries on 500/529/overloaded) ---
const RETRYABLE_PATTERNS = ["API Error: 500", "API Error: 529", "Internal server error", "overloaded", "rate_limit"];
const MAX_RETRIES = 3;

async function containerExecStreamWithRetry(container, command, onData) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const chunks = [];
    const wrappedOnData = (text) => {
      chunks.push(text);
      if (onData) onData(text);
    };

    const output = await containerExecStream(container, command, wrappedOnData);
    const outputStr = String(output);

    const isRetryable = RETRYABLE_PATTERNS.some(p => outputStr.includes(p));
    if (!isRetryable || attempt === MAX_RETRIES) {
      return output;
    }

    // Retryable error — wait with exponential backoff and retry
    const waitSec = attempt * 10;
    console.log("[Retry] Attempt " + attempt + "/" + MAX_RETRIES + " failed with retryable error, waiting " + waitSec + "s...");
    if (onData) onData("\n[Retrying in " + waitSec + "s due to API error... attempt " + (attempt + 1) + "/" + MAX_RETRIES + "]\n");
    await new Promise(r => setTimeout(r, waitSec * 1000));
  }
}

// --- Inject credentials into a container ---
async function injectCredentials(container) {
  const credentials = fs.readFileSync(CREDENTIALS_PATH, "utf8");
  await containerExec(container, "mkdir -p /home/agent/.claude");
  const credB64 = Buffer.from(credentials).toString("base64");
  await containerExec(container, "echo " + credB64 + " | base64 -d > /home/agent/.claude/.credentials.json");

  // Inject settings.json with bypassPermissions mode
  const settings = JSON.stringify({
    permissions: {
      defaultMode: "bypassPermissions",
      allow: ["Bash(*)", "Write(*)", "Edit(*)", "Read(*)", "WebFetch(*)", "WebSearch"],
    },
    hasCompletedOnboarding: true,
  });
  const settingsB64 = Buffer.from(settings).toString("base64");
  await containerExec(container, "echo " + settingsB64 + " | base64 -d > /home/agent/.claude/settings.json");
}

// --- Build publish instructions ---
function buildPublishInstructions(groupId, agentPort, subdomain) {
  return `

=== ENVIRONMENT ===
Docker container on Agentsfy. Shared filesystem: /workspace. App port: ${agentPort}.
Read context: cat /workspace/shared/context.json (api_url, api_token, conversation_id, user_id)
Read credentials: cat /workspace/shared/credentials.json — NEVER hardcode secrets.

=== PLATFORM TOOLS ===
API_URL=$(jq -r .api_url /workspace/shared/context.json)
API_TOKEN=$(jq -r .api_token /workspace/shared/context.json)
CONV_ID=$(jq -r .conversation_id /workspace/shared/context.json)

curl -s -X POST "$API_URL/api/tools/<name>" -H "x-api-token: $API_TOKEN" -H "Content-Type: application/json" -d '{"conversation_id":"'$CONV_ID'", ...args}'

Tools: schedule_create, deploy_app, credential_get, memory_search, memory_store, project_file_read/write, github_create_repo. Full schema: GET /api/tools.

=== REPLY STYLE — BE BRIEF ===
You are in a team chat. Keep messages SHORT (max 3 sentences unless explicitly asked for detail).
- "Salvei N items em /path" — DON'T paste the content.
- "Feito, ID: xyz" — DON'T paste the full JSON.
- Skip emoji headers, markdown tables, "Follow-up" sections, greetings/closings.
- If you failed, say what failed in one line and one fix suggestion.
- Actually CALL the tools, don't fake IDs.
- The schedule runs inside THIS group container — your team agents execute the task when it fires.
`;
}

// --- Build claude -p command with base64 encoding ---
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-4-7";

function buildClaudeCmd(prompt, systemPrompt, options = {}) {
  let cmd = "claude -p --permission-mode bypassPermissions --output-format stream-json --verbose";
  if (systemPrompt) {
    const sysB64 = Buffer.from(systemPrompt).toString("base64");
    cmd += ' --system-prompt "$(echo ' + sysB64 + ' | base64 -d)"';
  }
  cmd += " --model " + (options.model || DEFAULT_MODEL);
  if (options.max_turns) cmd += " --max-turns " + options.max_turns;
  if (options.allowedTools) {
    for (const t of options.allowedTools) cmd += " --allowedTools " + t;
  }
  const promptB64 = Buffer.from(prompt).toString("base64");
  return "echo " + promptB64 + " | base64 -d | " + cmd;
}

// Parse stream-json output from claude -p and emit structured events
// Returns { text, toolUses } and calls onEvent for each stream event
async function parseClaudeStream(container, command, onEvent) {
  let buffer = "";
  let fullText = "";
  const toolUses = [];

  const rawOutput = await containerExecStreamWithRetry(container, command, (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;
      try {
        const evt = JSON.parse(trimmed);
        if (evt.type === "assistant" && evt.message?.content) {
          for (const block of evt.message.content) {
            if (block.type === "text" && block.text) {
              fullText += block.text;
              onEvent({ type: "text", text: block.text });
            } else if (block.type === "tool_use") {
              toolUses.push({ name: block.name, input: block.input });
              onEvent({ type: "tool_use", name: block.name, input: block.input });
            }
          }
        } else if (evt.type === "user" && evt.message?.content) {
          for (const block of evt.message.content) {
            if (block.type === "tool_result") {
              const resultText = typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map(c => c.text || "").join("")
                  : "";
              onEvent({ type: "tool_result", output: resultText.slice(0, 2000) });
            }
          }
        } else if (evt.type === "result") {
          if (evt.result && !fullText) fullText = evt.result;
          onEvent({ type: "result", duration_ms: evt.duration_ms, cost: evt.total_cost_usd });
        }
      } catch (_) {}
    }
  });

  // If fullText is empty but rawOutput has content, use rawOutput (fallback)
  if (!fullText && rawOutput) {
    // Try to extract a final message from whatever we got
    fullText = rawOutput.slice(0, 4000);
  }
  return { text: fullText, toolUses };
}

// ============================================================
//  GROUPS API — 1 container, N agents as Claude Code sessions
// ============================================================

// --- POST /groups — Create a group with shared container ---
app.post("/groups", auth, async (req, res) => {
  try {
    const { name, members, description } = req.body;
    if (!name || !members || !Array.isArray(members) || members.length === 0) {
      return res.status(400).json({ error: "name and members[] are required" });
    }

    const id = uuidv4().slice(0, 8);
    const containerName = GROUP_PREFIX + id;
    const subdomain = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30);
    const mainPort = allocatePort();

    // Create deploy dir
    const deployDir = DEPLOYS_DIR + "/" + id;
    fs.mkdirSync(deployDir, { recursive: true });

    // Build port bindings — main port for the group
    const exposedPorts = { [mainPort + "/tcp"]: {} };
    const portBindings = { [mainPort + "/tcp"]: [{ HostPort: String(mainPort) }] };

    // Create single container for the whole group
    const container = await docker.createContainer({
      Image: IMAGE_NAME,
      name: containerName,
      Hostname: containerName,
      Env: [
        "GROUP_ID=" + id,
        "GROUP_NAME=" + name,
        "AGENT_PORT=" + mainPort,
      ],
      ExposedPorts: exposedPorts,
      HostConfig: {
        Memory: 4 * 1024 * 1024 * 1024, // 4GB for group
        CpuShares: 1024,
        RestartPolicy: { Name: "unless-stopped" },
        Binds: [deployDir + ":/publish"],
        PortBindings: portBindings,
      },
      Labels: {
        "claude-groups": "true",
        "group-id": id,
        "group-name": name,
        "group-port": String(mainPort),
      },
    });

    await container.start();
    await injectCredentials(container);

    // Create workspace dirs for each agent
    const memberDirs = members.map(m => "/workspace/" + m.name.replace(/[^a-z0-9_-]/gi, "_")).join(" ");
    await containerExec(container, "mkdir -p " + memberDirs + " /workspace/shared");

    // Verify Claude Code works
    const verify = await containerExec(container, 'echo "respond with exactly: GROUP_READY" | claude -p 2>&1');
    const isReady = verify.includes("GROUP_READY");

    const hostIp = getHostIp();
    const publishInstructions = buildPublishInstructions(id, mainPort, subdomain);

    // Build member registry
    const memberRegistry = members.map(m => ({
      id: m.id || uuidv4().slice(0, 8),
      name: m.name,
      role: m.role || m.name,
      system_prompt: (m.system_prompt || "You are " + m.name + ", a skilled professional.") + publishInstructions +
        "\nYou share /workspace with other agents. Your personal dir is /workspace/" + m.name.replace(/[^a-z0-9_-]/gi, "_") +
        " but you can read/write anywhere in /workspace. Use /workspace/shared for files other agents need.",
    }));

    const group = {
      id,
      name,
      description: description || "",
      container_name: containerName,
      container_id: container.id,
      status: isReady ? "ready" : "starting",
      members: memberRegistry,
      port: mainPort,
      subdomain,
      publish_url: "http://" + hostIp + ":" + PORT + "/sites/" + id + "/",
      dynamic_url: "http://" + hostIp + ":" + mainPort + "/",
      production_url: "https://" + subdomain + "." + DOMAIN,
      created_at: new Date().toISOString(),
      tasks_completed: 0,
    };

    groups.set(id, group);
    res.status(201).json(group);
  } catch (err) {
    console.error("Error creating group:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- GET /groups ---
app.get("/groups", auth, async (req, res) => {
  res.json(Array.from(groups.values()));
});

// --- GET /groups/:id ---
app.get("/groups/:id", auth, async (req, res) => {
  const group = groups.get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  res.json(group);
});

// --- DELETE /groups/:id ---
app.delete("/groups/:id", auth, async (req, res) => {
  try {
    const group = groups.get(req.params.id);
    if (!group) return res.status(404).json({ error: "Group not found" });
    const container = docker.getContainer(group.container_id);
    try { await container.stop(); } catch (_) {}
    await container.remove({ force: true });
    if (group.port) releasePort(group.port);
    groups.delete(req.params.id);
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /groups/:id/task — Send task to a specific agent in the group ---
app.post("/groups/:id/task", auth, async (req, res) => {
  const group = groups.get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });

  const { agent_name, prompt, system_prompt, model, max_turns, allowedTools, user_id } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  // Find agent in group
  const member = agent_name ? group.members.find(m => m.name === agent_name || m.id === agent_name) : null;

  // Inject memory context (3 scopes: agent + group + user)
  const memoryContext = await getMemoryContext(agent_name, group.id, user_id, prompt);
  const sysPrompt = (system_prompt || (member ? member.system_prompt : null) || "") + memoryContext;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const sendEvent = (event, data) => {
    res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
  };

  try {
    const container = docker.getContainer(group.container_id);
    const taskId = uuidv4().slice(0, 8);

    sendEvent("task.started", { task_id: taskId, group_id: group.id, agent_name: agent_name || "default", prompt });

    const cmd = buildClaudeCmd(prompt, sysPrompt, { model, max_turns, allowedTools });

    const { text: fullOutput } = await parseClaudeStream(container, cmd, (evt) => {
      if (evt.type === "text") sendEvent("task.output", { task_id: taskId, agent_name: agent_name || "default", text: evt.text });
      else if (evt.type === "tool_use") sendEvent("task.tool_use", { task_id: taskId, agent_name: agent_name || "default", tool: evt.name, input: evt.input });
      else if (evt.type === "tool_result") sendEvent("task.tool_result", { task_id: taskId, agent_name: agent_name || "default", output: evt.output });
    });

    group.tasks_completed++;

    // Auto-save memories (agent + group scopes)
    autoSaveMemory(agent_name, group.id, user_id, prompt, fullOutput.trim());

    sendEvent("task.completed", { task_id: taskId, agent_name: agent_name || "default", output: fullOutput.trim() });
  } catch (err) {
    sendEvent("task.error", { error: err.message });
  } finally {
    res.end();
  }
});

// --- POST /groups/:id/orchestrate — Full orchestration flow (SSE) ---
app.post("/groups/:id/orchestrate", auth, async (req, res) => {
  const group = groups.get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });

  const { prompt, context, user_id } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  // Inject group + user memory context into orchestrator
  const memoryContext = await getMemoryContext("orchestrator", group.id, user_id, prompt);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const sendEvent = (event, data) => {
    try { res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"); } catch (_) {}
  };

  try {
    const container = docker.getContainer(group.container_id);
    const hostIp = getHostIp();

    // Build orchestrator system prompt
    const memberList = group.members.map(m => "- " + m.name + " (" + m.role + ")").join("\n");
    const orchestratorPrompt = `You are the Orchestrator of group "${group.name}" in the Agentsfy platform.

## YOUR TEAM (delegate work to these agents):
${memberList}

These are YOUR agents. They run in the same container as you and have all the tools they need (Bash, Write, Edit, Read, WebFetch, WebSearch). When the user asks for something, you DELEGATE to the appropriate team member — you do NOT do the work yourself.

## WORKSPACE
- All members share /workspace. Use /workspace/shared for cross-agent files.
- Files in /publish are auto-served at http://HOST:${PORT}/sites/${group.id}/
- Port ${group.port} is available for dynamic apps
- Production URL: https://${group.subdomain}.${DOMAIN}
- User credentials (API keys, tokens) are in /workspace/shared/credentials.json

## CRITICAL RULES

1. **NEVER mention Anthropic MCP connectors, remote triggers, claude.ai settings, or "available in your account"** — those don't exist here. You are running inside the Agentsfy Docker container with your own team of agents.

2. **NEVER say an agent needs to be "connected"** — every agent listed above is already a member of this group and already inside this container. They can already do their job.

3. **Bitrix Agent, Web Researcher, and all other agents DO have access** to whatever they need. They read credentials from /workspace/shared/credentials.json and can make HTTP calls, run scripts, etc.

4. **NEVER invent job IDs, expiration dates, or fake confirmations.** The system handles scheduling automatically.

5. **NEVER refuse a schedule because of "minimum interval"** — there is NO minimum interval in the Agentsfy scheduler. Cron like */5 * * * * works fine.

## RESPONSE STYLE — BE BRIEF

You are having a conversation with the user. Talk like a team lead updating a chat, NOT writing a report.

- **ONE sentence plans.** "Vou pedir pro Web Researcher buscar as notícias, depois o Bitrix envia pro Lucas."
- **ONE line status updates.** "Web Researcher pronto — 8 notícias encontradas."
- **NO giant markdown tables, NO long bullet lists, NO emoji headers, NO "## Follow-up necessário".**
- **NO repeating agent output** — the user already saw what the agent said. Just confirm outcome.
- If something failed, say what and suggest ONE fix, in one line.
- Max 3 sentences per message.

## OUTPUT BLOCKS

Delegate (when needed):
DELEGATE:
[{"agent_name": "exact-member-name", "task": "what to do, with file paths and specifics"}]
END_DELEGATE

Schedule recurring tasks:
SCHEDULE:
{"cron": "*/5 * * * *", "name": "Name", "prompt": "what to do each run"}
END_SCHEDULE

Cron examples: */5 * * * * (5 min), 0 * * * * (hourly), 0 9 * * * (daily 9am).

For schedules: just output the block + ONE sentence "Agendei X a cada Y". Nothing else.

${context ? "\nCONVERSATION CONTEXT:\n" + context : ""}
${memoryContext}`;

    sendEvent("orchestrate.started", { group_id: group.id, prompt });

    // Step 1: Ask orchestrator to plan (stream-json)
    const planCmd = buildClaudeCmd(prompt, orchestratorPrompt, {});
    const { text: plan } = await parseClaudeStream(container, planCmd, (evt) => {
      if (evt.type === "text") {
        sendEvent("orchestrate.planning", { text: evt.text });
      } else if (evt.type === "tool_use") {
        sendEvent("agent.tool_use", { sender: "Orchestrator", tool: evt.name, input: evt.input });
      } else if (evt.type === "tool_result") {
        sendEvent("agent.tool_result", { sender: "Orchestrator", output: evt.output });
      }
    });

    sendEvent("orchestrate.plan_ready", { plan: (plan || "").trim() });

    // Step 2: Parse delegations
    const delegateMatch = plan.match(/DELEGATE:\s*\n?\s*(\[[\s\S]*?\])\s*\n?\s*END_DELEGATE/);
    let delegations = [];
    if (delegateMatch) {
      try { delegations = JSON.parse(delegateMatch[1]); } catch (_) {}
    }

    // Step 3: Execute delegated tasks in parallel
    const results = [];
    if (delegations.length > 0) {
      sendEvent("orchestrate.delegating", { tasks: delegations.map(d => ({ agent_name: d.agent_name, task: d.task.slice(0, 100) })) });

      const taskPromises = delegations.map(async (d) => {
        const member = group.members.find(m => m.name === d.agent_name);
        if (!member) return { agent_name: d.agent_name, output: "Agent not found in group", error: true };

        sendEvent("agent.started", { agent_name: d.agent_name, task: d.task });

        try {
          // Inject agent-specific memory
          const agentMemory = await getMemoryContext(d.agent_name, group.id, user_id, d.task);
          const agentSysPrompt = member.system_prompt + agentMemory;

          const taskCmd = buildClaudeCmd(d.task, agentSysPrompt, {


            allowedTools: ["Bash", "Write", "Edit", "Read"],
          });

          const { text: output } = await parseClaudeStream(container, taskCmd, (evt) => {
            if (evt.type === "text") {
              sendEvent("agent.output", { agent_name: d.agent_name, text: evt.text });
            } else if (evt.type === "tool_use") {
              sendEvent("agent.tool_use", { agent_name: d.agent_name, tool: evt.name, input: evt.input });
            } else if (evt.type === "tool_result") {
              sendEvent("agent.tool_result", { agent_name: d.agent_name, output: evt.output });
            }
          });

          // Auto-save agent + group memories
          autoSaveMemory(d.agent_name, group.id, user_id, d.task, output.trim());

          sendEvent("agent.completed", { agent_name: d.agent_name, output: output.trim() });
          return { agent_name: d.agent_name, output: output.trim() };
        } catch (err) {
          sendEvent("agent.error", { agent_name: d.agent_name, error: err.message });
          return { agent_name: d.agent_name, output: "Error: " + err.message, error: true };
        }
      });

      const settled = await Promise.all(taskPromises);
      results.push(...settled);
    }

    // Step 4: Synthesize results
    if (results.length > 0) {
      const synthesisPrompt = "Team finished. Results:\n\n" +
        results.map(r => "[" + r.agent_name + "] " + r.output.slice(0, 1500)).join("\n\n") +
        "\n\nIn 1-2 sentences, tell the user what got done. Include any live URLs. DO NOT make lists, tables, or re-paste agent output.";

      const synthesisCmd = buildClaudeCmd(synthesisPrompt, "You are the Orchestrator. Reply in 1-2 sentences max. No markdown tables, no bullet lists, no headings. Just what happened.", {});

      const { text: synthesis } = await parseClaudeStream(container, synthesisCmd, (evt) => {
        if (evt.type === "text") sendEvent("orchestrate.synthesis", { text: evt.text });
      });

      sendEvent("orchestrate.completed", { synthesis: (synthesis || "").trim(), results });
    } else {
      // No delegation — orchestrator answered directly
      sendEvent("orchestrate.completed", { synthesis: (plan || "").trim(), results: [] });
    }

    // Step 5: Check for schedules
    const scheduleMatch = plan.match(/SCHEDULE:\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*END_SCHEDULE/);
    if (scheduleMatch) {
      try {
        const schedule = JSON.parse(scheduleMatch[1]);
        sendEvent("schedule.created", schedule);
      } catch (_) {}
    }

    group.tasks_completed++;

    // Auto-save orchestration summary to group memory
    autoSaveMemory("orchestrator", group.id, user_id, prompt, plan.trim());
  } catch (err) {
    sendEvent("orchestrate.error", { error: err.message });
  } finally {
    res.end();
  }
});

// --- POST /groups/:id/exec — Run command in group container ---
app.post("/groups/:id/exec", auth, async (req, res) => {
  try {
    const group = groups.get(req.params.id);
    if (!group) return res.status(404).json({ error: "Group not found" });
    const container = docker.getContainer(group.container_id);
    const output = await containerExec(container, req.body.command);
    res.json({ output: output.trim(), group_id: group.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /groups/:id/members — Add member to existing group ---
app.post("/groups/:id/members", auth, async (req, res) => {
  const group = groups.get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const { name, role, system_prompt } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  const publishInstructions = buildPublishInstructions(group.id, group.port, group.subdomain);
  const member = {
    id: uuidv4().slice(0, 8),
    name,
    role: role || name,
    system_prompt: (system_prompt || "You are " + name + ", a skilled professional.") + publishInstructions +
      "\nYou share /workspace with other agents. Your personal dir is /workspace/" + name.replace(/[^a-z0-9_-]/gi, "_"),
  };

  group.members.push(member);

  // Create workspace dir
  const container = docker.getContainer(group.container_id);
  await containerExec(container, "mkdir -p /workspace/" + name.replace(/[^a-z0-9_-]/gi, "_"));

  res.json({ added: true, member });
});

// --- DELETE /groups/:id/members/:name ---
app.delete("/groups/:id/members/:name", auth, async (req, res) => {
  const group = groups.get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  group.members = group.members.filter(m => m.name !== req.params.name && m.id !== req.params.name);
  res.json({ removed: true });
});


// ============================================================
//  LEGACY AGENTS API — Individual containers (backwards compat)
// ============================================================

app.post("/agents", auth, async (req, res) => {
  try {
    const { name, system_prompt } = req.body;
    const id = uuidv4().slice(0, 8);
    const containerName = CONTAINER_PREFIX + id;
    const agentPort = allocatePort();
    const agentDeployDir = DEPLOYS_DIR + "/" + id;
    fs.mkdirSync(agentDeployDir, { recursive: true });

    const hostIp = getHostIp();
    const subdomain = (name || "agent-" + id).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30);

    const container = await docker.createContainer({
      Image: IMAGE_NAME, name: containerName, Hostname: containerName,
      Env: ["AGENT_ID=" + id, "AGENT_NAME=" + (name || "agent-" + id), "AGENT_PORT=" + agentPort],
      ExposedPorts: { [agentPort + "/tcp"]: {} },
      HostConfig: {
        Memory: 2 * 1024 * 1024 * 1024, CpuShares: 512,
        RestartPolicy: { Name: "unless-stopped" },
        Binds: [agentDeployDir + ":/publish"],
        PortBindings: { [agentPort + "/tcp"]: [{ HostPort: String(agentPort) }] },
      },
      Labels: { "claude-agents": "true", "agent-id": id, "agent-name": name || "agent-" + id, "agent-port": String(agentPort) },
    });

    await container.start();
    await injectCredentials(container);

    const verify = await containerExec(container, 'echo "respond with exactly: AGENT_READY" | claude -p 2>&1');
    const publishInstructions = buildPublishInstructions(id, agentPort, subdomain);

    const agent = {
      id, name: name || "agent-" + id, container_name: containerName, container_id: container.id,
      status: verify.includes("AGENT_READY") ? "ready" : "auth_pending",
      system_prompt: (system_prompt || "") + publishInstructions,
      port: agentPort, subdomain,
      publish_url: "http://" + hostIp + ":" + PORT + "/sites/" + id + "/",
      dynamic_url: "http://" + hostIp + ":" + agentPort + "/",
      production_url: "https://" + subdomain + "." + DOMAIN,
      created_at: new Date().toISOString(), tasks_completed: 0,
    };
    agents.set(id, agent);
    res.status(201).json(agent);
  } catch (err) {
    console.error("Error creating agent:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/agents", auth, (req, res) => { res.json(Array.from(agents.values())); });

app.get("/agents/:id", auth, (req, res) => {
  const agent = agents.get(req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  res.json(agent);
});

app.delete("/agents/:id", auth, async (req, res) => {
  try {
    const agent = agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const container = docker.getContainer(agent.container_id);
    try { await container.stop(); } catch (_) {}
    await container.remove({ force: true });
    if (agent.port) releasePort(agent.port);
    agents.delete(req.params.id);
    res.json({ deleted: true, id: req.params.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/agents/:id/task", auth, async (req, res) => {
  const agent = agents.get(req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  const { prompt, system_prompt, model, max_turns, allowedTools } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const sendEvent = (event, data) => { res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"); };

  try {
    const container = docker.getContainer(agent.container_id);
    const taskId = uuidv4().slice(0, 8);
    sendEvent("task.started", { task_id: taskId, agent_id: agent.id, prompt });
    const cmd = buildClaudeCmd(prompt, system_prompt || agent.system_prompt, { model, max_turns, allowedTools });
    const fullOutput = await containerExecStreamWithRetry(container, cmd, (chunk) => {
      sendEvent("task.output", { task_id: taskId, text: chunk });
    });
    agent.tasks_completed++;
    sendEvent("task.completed", { task_id: taskId, agent_id: agent.id, output: fullOutput.trim() });
  } catch (err) { sendEvent("task.error", { error: err.message }); }
  finally { res.end(); }
});

app.post("/agents/:id/exec", auth, async (req, res) => {
  try {
    const agent = agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const container = docker.getContainer(agent.container_id);
    const output = await containerExec(container, req.body.command);
    res.json({ output: output.trim(), agent_id: agent.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/agents/:id/upload", auth, async (req, res) => {
  try {
    const agent = agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) return res.status(400).json({ error: "path and content required" });
    const container = docker.getContainer(agent.container_id);
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (dir) await containerExec(container, "mkdir -p " + dir);
    const b64 = Buffer.from(content).toString("base64");
    await containerExec(container, "echo " + b64 + " | base64 -d > " + filePath);
    res.json({ uploaded: true, path: filePath, agent_id: agent.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  MEMORY API — query/store across 3 scopes
// ============================================================

// --- POST /memory/store ---
app.post("/memory/store", auth, async (req, res) => {
  const { tenant_type, tenant_id, content, wing, room, tags } = req.body;
  if (!tenant_type || !tenant_id || !content) {
    return res.status(400).json({ error: "tenant_type, tenant_id, content required" });
  }
  const result = await storeMemory(tenant_type, tenant_id, content, wing, room, tags);
  res.json(result || { error: "MemPalace unavailable" });
});

// --- POST /memory/search ---
app.post("/memory/search", auth, async (req, res) => {
  const { tenant_type, tenant_id, query, limit } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });

  if (tenant_type && tenant_id) {
    const result = await searchMemory(tenant_type, tenant_id, query, limit);
    return res.json(result || { results: [] });
  }

  // Multi-scope search
  const { agent_name, group_id, user_id } = req.body;
  const tenants = [];
  if (agent_name) tenants.push({ type: "agent", id: agent_name });
  if (group_id) tenants.push({ type: "group", id: group_id });
  if (user_id) tenants.push({ type: "user", id: user_id });

  if (tenants.length === 0) return res.status(400).json({ error: "specify tenant_type+tenant_id or agent_name/group_id/user_id" });

  const result = await searchMultiMemory(tenants, query, limit);
  res.json(result || { results: [] });
});

// --- GET /memory/list ---
app.get("/memory/list", auth, async (req, res) => {
  const { tenant_type, tenant_id, wing, limit } = req.query;
  if (!tenant_type || !tenant_id) return res.status(400).json({ error: "tenant_type and tenant_id required" });

  try {
    const url = new URL(MEMPALACE_URL + "/api/memories/list");
    url.searchParams.set("tenant_type", tenant_type);
    url.searchParams.set("tenant_id", tenant_id);
    if (wing) url.searchParams.set("wing", wing);
    if (limit) url.searchParams.set("limit", limit);

    const r = await fetch(url.toString());
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /groups/:id/memories — List all memories for a group (agents + group scope) ---
app.get("/groups/:id/memories", auth, async (req, res) => {
  const group = groups.get(req.params.id);
  if (!group) return res.status(404).json({ error: "Group not found" });

  try {
    // Get group-scope memories
    const groupUrl = new URL(MEMPALACE_URL + "/api/memories/list");
    groupUrl.searchParams.set("tenant_type", "group");
    groupUrl.searchParams.set("tenant_id", group.id);
    groupUrl.searchParams.set("limit", "50");
    const groupRes = await fetch(groupUrl.toString());
    const groupData = await groupRes.json();

    // Get per-agent memories
    const agentMemories = {};
    for (const m of group.members) {
      const agentUrl = new URL(MEMPALACE_URL + "/api/memories/list");
      agentUrl.searchParams.set("tenant_type", "agent");
      agentUrl.searchParams.set("tenant_id", m.name);
      agentUrl.searchParams.set("limit", "20");
      const agentRes = await fetch(agentUrl.toString());
      const agentData = await agentRes.json();
      agentMemories[m.name] = agentData.memories || [];
    }

    res.json({
      group_memories: groupData.memories || [],
      agent_memories: agentMemories,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  HEALTH + RECOVERY
// ============================================================

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "claude-agents", agents_count: agents.size, groups_count: groups.size, uptime: process.uptime() });
});

async function recoverAgents() {
  try {
    // Recover individual agents
    const agentContainers = await docker.listContainers({ all: true, filters: { label: ["claude-agents=true"] } });
    for (const c of agentContainers) {
      const id = c.Labels["agent-id"];
      const port = c.Labels["agent-port"] ? parseInt(c.Labels["agent-port"]) : null;
      if (id) {
        if (port) allocatedPorts.add(port);
        const hostIp = getHostIp();
        agents.set(id, {
          id, name: c.Labels["agent-name"] || "recovered-" + id,
          container_name: c.Names[0] ? c.Names[0].replace("/", "") : "",
          container_id: c.Id, status: c.State === "running" ? "ready" : "stopped",
          docker_status: c.State, port,
          publish_url: "http://" + hostIp + ":" + PORT + "/sites/" + id + "/",
          dynamic_url: port ? "http://" + hostIp + ":" + port + "/" : null,
          created_at: c.Created ? new Date(c.Created * 1000).toISOString() : null,
          tasks_completed: 0, recovered: true,
        });
      }
    }

    // Recover groups
    const groupContainers = await docker.listContainers({ all: true, filters: { label: ["claude-groups=true"] } });
    for (const c of groupContainers) {
      const id = c.Labels["group-id"];
      const port = c.Labels["group-port"] ? parseInt(c.Labels["group-port"]) : null;
      if (id) {
        if (port) allocatedPorts.add(port);
        const hostIp = getHostIp();
        groups.set(id, {
          id, name: c.Labels["group-name"] || "recovered-" + id,
          container_name: c.Names[0] ? c.Names[0].replace("/", "") : "",
          container_id: c.Id, status: c.State === "running" ? "ready" : "stopped",
          members: [], port,
          publish_url: "http://" + hostIp + ":" + PORT + "/sites/" + id + "/",
          dynamic_url: port ? "http://" + hostIp + ":" + port + "/" : null,
          created_at: c.Created ? new Date(c.Created * 1000).toISOString() : null,
          tasks_completed: 0, recovered: true,
        });
      }
    }

    console.log("Recovered " + agents.size + " agents, " + groups.size + " groups");
  } catch (err) { console.error("Recovery failed:", err.message); }
}

recoverAgents().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("");
    console.log("Claude Agents API running on port " + PORT);
    console.log("  Agents: " + agents.size + " | Groups: " + groups.size);
    console.log("  Image: " + IMAGE_NAME);
    console.log("");
  });
});
