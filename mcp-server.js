#!/usr/bin/env node
/**
 * MCP stdio server that exposes orchestration tools to Claude CLI.
 * Runs INSIDE the group container. Claude connects via --mcp-config.
 *
 * Tools exposed:
 *   - delegate_agent(agent_name, task)  → run another agent in this container
 *   - ask_user(question)                → post question, signal end of turn
 *   - finish(summary)                   → explicit finish
 *
 * Communicates with the outer claude-agents API via HTTP callback to
 * dispatch subagent executions (claude-agents has dockerode).
 */

const readline = require("readline");
const http = require("http");

const CALLBACK_URL = process.env.MCP_CALLBACK_URL || "http://host.docker.internal:8201";
const GROUP_ID = process.env.GROUP_ID;
const CONV_ID = process.env.CONV_ID;
const CORRELATION_TOKEN = process.env.MCP_TOKEN || "";

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(CALLBACK_URL + path);
      const data = JSON.stringify(body);
      const req = http.request({
        hostname: url.hostname, port: url.port, path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          "x-mcp-token": CORRELATION_TOKEN,
        },
      }, (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          try { resolve(JSON.parse(raw || "{}")); } catch { resolve({ raw }); }
        });
      });
      req.on("error", reject);
      req.write(data);
      req.end();
    } catch (e) { reject(e); }
  });
}

// MCP protocol over stdio (JSON-RPC)
const tools = [
  {
    name: "delegate_agent",
    description: "Delegate a task to a member agent of this group. Returns the agent's output. Use this when you need a specialist to do work. For sequential dependencies (A writes file, B reads it), just call delegate_agent again after the first returns.",
    inputSchema: {
      type: "object",
      required: ["agent_name", "task"],
      properties: {
        agent_name: { type: "string", description: "Exact name of the team member agent" },
        task: { type: "string", description: "Detailed task description" },
      },
    },
  },
  {
    name: "ask_user",
    description: "Ask the user a question and pause the orchestration. Use when you need information you do not have.",
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string" },
      },
    },
  },
  {
    name: "finish",
    description: "Signal you are done with the current user request. Optionally provide a brief summary.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
      },
    },
  },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "agentsfy-orchestrator", version: "1.0.0" },
        },
      });
      return;
    }

    if (method === "notifications/initialized") return;

    if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools } });
      return;
    }

    if (method === "tools/call") {
      const { name, arguments: args } = params;
      let result;

      if (name === "delegate_agent") {
        result = await httpPost("/delegate", {
          group_id: GROUP_ID,
          conv_id: CONV_ID,
          agent_name: args.agent_name,
          task: args.task,
        });
      } else if (name === "ask_user") {
        result = await httpPost("/ask-user", {
          group_id: GROUP_ID,
          conv_id: CONV_ID,
          question: args.question,
        });
      } else if (name === "finish") {
        result = { finished: true, summary: args.summary || "" };
        await httpPost("/finish", { group_id: GROUP_ID, conv_id: CONV_ID, summary: args.summary });
      } else {
        result = { error: "unknown tool: " + name };
      }

      send({
        jsonrpc: "2.0", id,
        result: {
          content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
        },
      });
      return;
    }

    // Unsupported method
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
  } catch (err) {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: err.message } });
  }
});

// Announce ready (stderr to not interfere with JSON-RPC stdout)
process.stderr.write("[mcp] ready — tools: " + tools.map(t => t.name).join(", ") + "\n");
