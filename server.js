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
const IMAGE_NAME = "claude-agent:latest";
const CONTAINER_PREFIX = "claude-agent-";

// In-memory agent registry
const agents = new Map();

// --- Auth middleware ---
function auth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (key !== API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// --- Helper: exec command in container ---
async function containerExec(container, command, env = []) {
  const exec = await container.exec({
    Cmd: ["bash", "-c", command],
    AttachStdout: true,
    AttachStderr: true,
    Env: env,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => {
      const payload = chunk.length > 8 ? chunk.slice(8) : chunk;
      chunks.push(payload);
    });
    stream.on("end", () => {
      const output = Buffer.concat(chunks).toString("utf8");
      resolve(output);
    });
    stream.on("error", reject);
  });
}

// --- Helper: exec with streaming ---
async function containerExecStream(container, command, onData) {
  const exec = await container.exec({
    Cmd: ["bash", "-c", command],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => {
      const payload = chunk.length > 8 ? chunk.slice(8) : chunk;
      const text = payload.toString("utf8");
      chunks.push(text);
      if (onData) onData(text);
    });
    stream.on("end", () => resolve(chunks.join("")));
    stream.on("error", reject);
  });
}

// --- POST /agents - Create a new agent ---
app.post("/agents", auth, async (req, res) => {
  try {
    const { name, system_prompt } = req.body;
    const id = uuidv4().slice(0, 8);
    const containerName = CONTAINER_PREFIX + id;

    const credentials = fs.readFileSync(CREDENTIALS_PATH, "utf8");

    const container = await docker.createContainer({
      Image: IMAGE_NAME,
      name: containerName,
      Hostname: containerName,
      Env: [
        "AGENT_ID=" + id,
        "AGENT_NAME=" + (name || "agent-" + id),
      ],
      HostConfig: {
        Memory: 2 * 1024 * 1024 * 1024,
        CpuShares: 512,
        RestartPolicy: { Name: "unless-stopped" },
      },
      Labels: {
        "claude-agents": "true",
        "agent-id": id,
        "agent-name": name || "agent-" + id,
      },
    });

    await container.start();

    // Inject credentials
    await containerExec(container, "mkdir -p /root/.claude");

    // Write credentials as base64 to avoid escaping issues
    const credB64 = Buffer.from(credentials).toString("base64");
    await containerExec(container, "echo " + credB64 + " | base64 -d > /root/.claude/.credentials.json");

    // Verify Claude Code works
    const verify = await containerExec(container, 'echo "respond with exactly: AGENT_READY" | claude -p 2>&1');
    const isReady = verify.includes("AGENT_READY");

    const agent = {
      id,
      name: name || "agent-" + id,
      container_name: containerName,
      container_id: container.id,
      status: isReady ? "ready" : "auth_pending",
      system_prompt: system_prompt || null,
      created_at: new Date().toISOString(),
      tasks_completed: 0,
    };

    agents.set(id, agent);
    res.status(201).json(agent);
  } catch (err) {
    console.error("Error creating agent:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- GET /agents - List all agents ---
app.get("/agents", auth, async (req, res) => {
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: ["claude-agents=true"] },
    });

    for (const c of containers) {
      const id = c.Labels["agent-id"];
      if (id && agents.has(id)) {
        agents.get(id).docker_status = c.State;
      }
    }

    res.json(Array.from(agents.values()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /agents/:id ---
app.get("/agents/:id", auth, async (req, res) => {
  const agent = agents.get(req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  res.json(agent);
});

// --- DELETE /agents/:id ---
app.delete("/agents/:id", auth, async (req, res) => {
  try {
    const agent = agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const container = docker.getContainer(agent.container_id);
    try { await container.stop(); } catch (_) {}
    await container.remove({ force: true });
    agents.delete(req.params.id);

    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /agents/:id/task - Send task (SSE streaming) ---
app.post("/agents/:id/task", auth, async (req, res) => {
  const agent = agents.get(req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  const { prompt, system_prompt, model, max_turns, allowedTools } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

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
    const container = docker.getContainer(agent.container_id);
    const taskId = uuidv4().slice(0, 8);

    sendEvent("task.started", { task_id: taskId, agent_id: agent.id, prompt });

    // Build claude command
    let cmd = "claude -p";

    const sysPrompt = system_prompt || agent.system_prompt;
    if (sysPrompt) {
      const sysB64 = Buffer.from(sysPrompt).toString("base64");
      cmd += " --system-prompt \"$(echo " + sysB64 + " | base64 -d)\"";
    }

    if (model) cmd += " --model " + model;
    if (max_turns) cmd += " --max-turns " + max_turns;

    if (allowedTools && Array.isArray(allowedTools)) {
      for (const tool of allowedTools) {
        cmd += " --allowedTools " + tool;
      }
    }

    // Encode prompt as base64 to avoid escaping issues
    const promptB64 = Buffer.from(prompt).toString("base64");
    cmd = "echo " + promptB64 + " | base64 -d | " + cmd;

    sendEvent("task.executing", { task_id: taskId, command: cmd });

    const fullOutput = await containerExecStream(container, cmd, (chunk) => {
      sendEvent("task.output", { task_id: taskId, text: chunk });
    });

    agent.tasks_completed++;

    sendEvent("task.completed", {
      task_id: taskId,
      agent_id: agent.id,
      output: fullOutput.trim(),
    });
  } catch (err) {
    sendEvent("task.error", { error: err.message });
  } finally {
    res.end();
  }
});

// --- POST /agents/:id/exec - Run command in container ---
app.post("/agents/:id/exec", auth, async (req, res) => {
  try {
    const agent = agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const { command } = req.body;
    if (!command) return res.status(400).json({ error: "command is required" });

    const container = docker.getContainer(agent.container_id);
    const output = await containerExec(container, command);

    res.json({ output: output.trim(), agent_id: agent.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /agents/:id/upload - Upload file to container ---
app.post("/agents/:id/upload", auth, async (req, res) => {
  try {
    const agent = agents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) {
      return res.status(400).json({ error: "path and content are required" });
    }

    const container = docker.getContainer(agent.container_id);

    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (dir) await containerExec(container, "mkdir -p " + dir);

    const contentB64 = Buffer.from(content).toString("base64");
    await containerExec(container, "echo " + contentB64 + " | base64 -d > " + filePath);

    res.json({ uploaded: true, path: filePath, agent_id: agent.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /agents/:id/conversation - Multi-turn with --resume ---
app.post("/agents/:id/conversation", auth, async (req, res) => {
  const agent = agents.get(req.params.id);
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  const { prompt, session_id } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

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
    const container = docker.getContainer(agent.container_id);

    let cmd = "claude -p";
    if (session_id) cmd += " --resume " + session_id;

    const promptB64 = Buffer.from(prompt).toString("base64");
    cmd = "echo " + promptB64 + " | base64 -d | " + cmd;

    sendEvent("conversation.started", { agent_id: agent.id, session_id });

    const fullOutput = await containerExecStream(container, cmd, (chunk) => {
      sendEvent("conversation.output", { text: chunk });
    });

    sendEvent("conversation.completed", { output: fullOutput.trim() });
  } catch (err) {
    sendEvent("conversation.error", { error: err.message });
  } finally {
    res.end();
  }
});

// --- GET /health ---
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "claude-agents",
    agents_count: agents.size,
    uptime: process.uptime(),
  });
});

// --- Recovery on startup ---
async function recoverAgents() {
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: ["claude-agents=true"] },
    });

    for (const c of containers) {
      const id = c.Labels["agent-id"];
      if (id) {
        agents.set(id, {
          id,
          name: c.Labels["agent-name"] || "recovered-" + id,
          container_name: c.Names[0] ? c.Names[0].replace("/", "") : "",
          container_id: c.Id,
          status: c.State === "running" ? "ready" : "stopped",
          docker_status: c.State,
          created_at: c.Created ? new Date(c.Created * 1000).toISOString() : null,
          tasks_completed: 0,
          recovered: true,
        });
      }
    }
    console.log("Recovered " + agents.size + " agents from Docker");
  } catch (err) {
    console.error("Recovery failed:", err.message);
  }
}

recoverAgents().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("");
    console.log("Claude Agents API running on port " + PORT);
    console.log("  Agents: " + agents.size);
    console.log("  Image: " + IMAGE_NAME);
    console.log("  Credentials: " + CREDENTIALS_PATH);
    console.log("");
  });
});
