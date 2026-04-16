import { supabase } from "./supabase.js";

export interface ToolContext {
  userId: string;
  conversationId?: string;
  agentId?: string;
}

export interface PlatformTool {
  name: string;
  description: string;
  args_schema: object; // JSON schema
  handler: (args: any, ctx: ToolContext) => Promise<any>;
}

export const PLATFORM_TOOLS: PlatformTool[] = [
  {
    name: "schedule_create",
    description: "Create a recurring task that fires on a cron schedule. The task runs inside this group container.",
    args_schema: {
      type: "object",
      required: ["conversation_id", "cron", "prompt"],
      properties: {
        conversation_id: { type: "string", description: "Group conversation ID" },
        cron: { type: "string", description: "Cron expression, e.g. '*/10 * * * *'" },
        name: { type: "string", description: "Optional schedule name" },
        prompt: { type: "string", description: "Task prompt to execute each run" },
      },
    },
    handler: async (args, ctx) => {
      const { conversation_id, cron, name, prompt } = args;
      let nextRun = new Date(Date.now() + 60_000).toISOString();
      try {
        const cp: any = await import("cron-parser");
        const Parser = cp.CronExpressionParser || cp.default;
        nextRun = Parser.parse(cron).next().toDate().toISOString();
      } catch {}

      const { data, error } = await supabase
        .from("group_schedules")
        .insert({
          conversation_id,
          created_by_user_id: ctx.userId,
          name: name || "Scheduled task",
          cron,
          prompt,
          active: true,
          next_run_at: nextRun,
        })
        .select()
        .single();

      if (error) throw new Error(error.message);
      return { id: data.id, next_run_at: data.next_run_at, cron: data.cron };
    },
  },

  {
    name: "schedule_list",
    description: "List recurring tasks for a group.",
    args_schema: {
      type: "object",
      required: ["conversation_id"],
      properties: {
        conversation_id: { type: "string" },
      },
    },
    handler: async (args) => {
      const { data } = await supabase
        .from("group_schedules")
        .select("id, name, cron, prompt, active, next_run_at, last_run_at, run_count")
        .eq("conversation_id", args.conversation_id)
        .order("created_at", { ascending: false });
      return { schedules: data || [] };
    },
  },

  {
    name: "schedule_delete",
    description: "Delete a recurring task.",
    args_schema: {
      type: "object",
      required: ["schedule_id"],
      properties: { schedule_id: { type: "string" } },
    },
    handler: async (args) => {
      await supabase.from("group_schedules").delete().eq("id", args.schedule_id);
      return { deleted: true };
    },
  },

  {
    name: "deploy_app",
    description: "Deploy the running app to the group's production subdomain (*.agentsfy.cc).",
    args_schema: {
      type: "object",
      required: ["conversation_id"],
      properties: {
        conversation_id: { type: "string" },
        name: { type: "string", description: "Optional subdomain name (defaults to group slug)" },
      },
    },
    handler: async (args, ctx) => {
      const { data: conv } = await supabase.from("conversations").select("*").eq("id", args.conversation_id).single();
      if (!conv) throw new Error("Conversation not found");
      const gc: any = conv.group_config;
      const subdomain = args.name || gc?.subdomain;
      const port = gc?.port;
      const containerName = "claude-group-" + gc?.claude_group_id;

      await fetch("http://127.0.0.1:9090/containers/" + containerName + "/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "agentify-cloud-secret-2026" },
        body: JSON.stringify({ app_name: subdomain, port, command: "serve /publish -l " + port + " -s" }),
      });
      await fetch("http://127.0.0.1:9090/subdomains", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "agentify-cloud-secret-2026" },
        body: JSON.stringify({ subdomain, container_name: containerName, port, ip: "127.0.0.1" }),
      });
      return { url: "https://" + subdomain + ".agentsfy.cc", port };
    },
  },

  {
    name: "credential_get",
    description: "Get a user credential by name (e.g. 'bitrix_api_key', 'github_token'). Returns null if not found.",
    args_schema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    },
    handler: async (args, ctx) => {
      const { data } = await supabase
        .from("user_secrets")
        .select("credential")
        .eq("user_id", ctx.userId)
        .eq("name", args.name)
        .maybeSingle();
      return { name: args.name, value: data?.credential || null };
    },
  },

  {
    name: "memory_search",
    description: "Search user memories semantically across all scopes (user, agents, groups, projects).",
    args_schema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 10 },
      },
    },
    handler: async (args, ctx) => {
      const res = await fetch("http://127.0.0.1:8100/api/memories/search-multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenants: [{ type: "user", id: ctx.userId }],
          query: args.query,
          limit: args.limit || 10,
        }),
      });
      const d: any = await res.json();
      return { results: d.results || [] };
    },
  },

  {
    name: "memory_store",
    description: "Store a memory for the user (survives across sessions and agents).",
    args_schema: {
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "string" },
        wing: { type: "string", description: "Optional category" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
    handler: async (args, ctx) => {
      const res = await fetch("http://127.0.0.1:8100/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenant_type: "user",
          tenant_id: ctx.userId,
          content: args.content,
          wing: args.wing || "general",
          tags: args.tags || [],
        }),
      });
      const d: any = await res.json();
      return { stored: true, id: d.memory_id };
    },
  },

  {
    name: "project_file_read",
    description: "Read a file from the user's cloud container.",
    args_schema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
    },
    handler: async (args, ctx) => {
      const container = "agentify-user-" + ctx.userId.slice(0, 30);
      const res = await fetch("http://127.0.0.1:9090/containers/" + container + "/files/download?path=" + encodeURIComponent(args.path), {
        headers: { "x-api-key": "agentify-cloud-secret-2026" },
      });
      const d: any = await res.json();
      return { content: d.content, size: d.content?.length || 0 };
    },
  },

  {
    name: "project_file_write",
    description: "Write a file to the user's cloud container.",
    args_schema: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      const container = "agentify-user-" + ctx.userId.slice(0, 30);
      await fetch("http://127.0.0.1:9090/containers/" + container + "/files/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "agentify-cloud-secret-2026" },
        body: JSON.stringify({ path: args.path, content: args.content }),
      });
      return { written: true, path: args.path };
    },
  },

  {
    name: "github_create_repo",
    description: "Create a GitHub repository in the user's account (requires github_token credential).",
    args_schema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        private: { type: "boolean", default: true },
        description: { type: "string" },
      },
    },
    handler: async (args, ctx) => {
      const { data: tok } = await supabase.from("user_secrets").select("credential").eq("user_id", ctx.userId).eq("name", "github_token").maybeSingle();
      if (!tok?.credential) throw new Error("github_token credential not set");
      const res = await fetch("https://api.github.com/user/repos", {
        method: "POST",
        headers: { Authorization: "token " + tok.credential, "Content-Type": "application/json" },
        body: JSON.stringify({ name: args.name, private: args.private !== false, description: args.description }),
      });
      const d: any = await res.json();
      if (!res.ok) throw new Error(d.message || "GitHub error");
      return { url: d.html_url, clone_url: d.clone_url };
    },
  },
];

export function getToolByName(name: string): PlatformTool | null {
  return PLATFORM_TOOLS.find(t => t.name === name) || null;
}

export function buildToolCatalog(agentTools: any[] = []): string {
  const lines = ["=== AVAILABLE TOOLS ==="];
  lines.push("");
  lines.push("Read your context first:");
  lines.push("  cat /workspace/shared/context.json");
  lines.push("  # Contains: api_url, api_token, conversation_id, user_id");
  lines.push("");
  lines.push("Invoke any tool with:");
  lines.push('  curl -s -X POST $API_URL/api/tools/<tool_name> \\');
  lines.push('    -H "x-api-token: $API_TOKEN" \\');
  lines.push('    -H "Content-Type: application/json" \\');
  lines.push("    -d '<args_json>'");
  lines.push("");
  lines.push("Always include conversation_id in args when the tool requires context.");
  lines.push("");
  lines.push("## PLATFORM TOOLS (always available)");
  for (const t of PLATFORM_TOOLS) {
    lines.push("");
    lines.push("### " + t.name);
    lines.push(t.description);
    const args = Object.keys((t.args_schema as any).properties || {});
    if (args.length) lines.push("Args: " + args.join(", "));
  }
  if (agentTools.length > 0) {
    lines.push("");
    lines.push("## YOUR SPECIALIST TOOLS");
    for (const t of agentTools) {
      lines.push("");
      lines.push("### " + t.name);
      lines.push(t.description || "");
    }
  }
  return lines.join("\n");
}
