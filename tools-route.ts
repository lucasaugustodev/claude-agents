import { FastifyInstance } from "fastify";
import { supabase } from "../lib/supabase.js";
import { getToolByName } from "../lib/tool-registry.js";
import { randomBytes } from "node:crypto";

export async function toolsRoutes(app: FastifyInstance) {
  // Helper: get or create user's api_token
  app.get("/api/me/api-token", async (request, reply) => {
    const { requireAuth } = await import("../lib/auth.js");
    await requireAuth(request, reply);
    const userId = (request as any).userId;
    if (!userId) return;

    const { data: existing } = await supabase
      .from("user_api_tokens")
      .select("token")
      .eq("user_id", userId)
      .maybeSingle();

    if (existing?.token) return { token: existing.token };

    const token = "at_" + randomBytes(24).toString("hex");
    await supabase.from("user_api_tokens").insert({ user_id: userId, token });
    return { token };
  });

  // Token-authenticated tool call endpoint (used by agents)
  app.post<{ Params: { name: string }; Body: any }>(
    "/api/tools/:name",
    async (request, reply) => {
      const start = Date.now();
      const apiToken = request.headers["x-api-token"] as string;
      if (!apiToken) return reply.status(401).send({ error: "x-api-token required" });

      const { data: tokenRow } = await supabase
        .from("user_api_tokens")
        .select("user_id")
        .eq("token", apiToken)
        .maybeSingle();

      if (!tokenRow) return reply.status(401).send({ error: "invalid token" });
      const userId = tokenRow.user_id;

      const toolName = request.params.name;
      const args = (request.body || {}) as any;
      const conversationId = args.conversation_id;

      // Try platform tool first
      const platformTool = getToolByName(toolName);
      if (platformTool) {
        try {
          const result = await platformTool.handler(args, { userId, conversationId });
          await supabase.from("tool_calls").insert({
            user_id: userId,
            conversation_id: conversationId,
            tool_name: toolName,
            args,
            result,
            duration_ms: Date.now() - start,
          });
          return reply.send(result);
        } catch (e: any) {
          await supabase.from("tool_calls").insert({
            user_id: userId,
            conversation_id: conversationId,
            tool_name: toolName,
            args,
            error: e.message,
            duration_ms: Date.now() - start,
          });
          return reply.status(500).send({ error: e.message });
        }
      }

      // Try agent tool
      const agentId = args.agent_id;
      if (agentId) {
        const { data: agentTool } = await supabase
          .from("agent_tools")
          .select("*")
          .eq("agent_id", agentId)
          .eq("name", toolName)
          .maybeSingle();

        if (agentTool) {
          try {
            const result = await executeAgentTool(agentTool, args, { userId, conversationId });
            await supabase.from("tool_calls").insert({
              user_id: userId,
              agent_id: agentId,
              conversation_id: conversationId,
              tool_name: toolName,
              args,
              result,
              duration_ms: Date.now() - start,
            });
            return reply.send(result);
          } catch (e: any) {
            return reply.status(500).send({ error: e.message });
          }
        }
      }

      return reply.status(404).send({ error: "tool not found: " + toolName });
    }
  );

  // List platform tools catalog (public endpoint for discovery)
  app.get("/api/tools", async () => {
    const { PLATFORM_TOOLS } = await import("../lib/tool-registry.js");
    return {
      tools: PLATFORM_TOOLS.map(t => ({
        name: t.name,
        description: t.description,
        args_schema: t.args_schema,
      })),
    };
  });

  // Agent tools CRUD
  app.get<{ Params: { agentId: string } }>(
    "/api/agents/:agentId/tools",
    async (request, reply) => {
      const { requireAuth } = await import("../lib/auth.js");
      await requireAuth(request, reply);
      const { data } = await supabase
        .from("agent_tools")
        .select("*")
        .eq("agent_id", request.params.agentId);
      return { tools: data || [] };
    }
  );

  app.post<{ Params: { agentId: string }; Body: any }>(
    "/api/agents/:agentId/tools",
    async (request, reply) => {
      const { requireAuth } = await import("../lib/auth.js");
      await requireAuth(request, reply);
      const { name, description, args_schema, handler_type, handler_config } = request.body;
      const { data, error } = await supabase.from("agent_tools").insert({
        agent_id: request.params.agentId,
        name, description, args_schema: args_schema || {},
        handler_type: handler_type || "http",
        handler_config: handler_config || {},
      }).select().single();
      if (error) return reply.status(400).send({ error: error.message });
      return { tool: data };
    }
  );

  app.delete<{ Params: { agentId: string; toolId: string } }>(
    "/api/agents/:agentId/tools/:toolId",
    async (request, reply) => {
      const { requireAuth } = await import("../lib/auth.js");
      await requireAuth(request, reply);
      await supabase.from("agent_tools").delete().eq("id", request.params.toolId);
      return { deleted: true };
    }
  );
}

async function executeAgentTool(tool: any, args: any, ctx: any): Promise<any> {
  const cfg = tool.handler_config || {};
  if (tool.handler_type === "http") {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(cfg.headers || {}) };
    // Allow templating ${credential:name} in headers
    for (const [k, v] of Object.entries(headers)) {
      const match = String(v).match(/\$\{credential:([^}]+)\}/);
      if (match) {
        const { data } = await supabase.from("user_secrets").select("credential").eq("user_id", ctx.userId).eq("name", match[1]).maybeSingle();
        headers[k] = String(v).replace(match[0], data?.credential || "");
      }
    }
    const method = cfg.method || "POST";
    const url = cfg.url;
    const body = method === "GET" ? undefined : JSON.stringify(args);
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { response: text }; }
  }
  if (tool.handler_type === "script") {
    let script = cfg.script;
    for (const [k, v] of Object.entries(args)) {
      script = script.replaceAll("${" + k + "}", String(v));
    }
    return { output: "script execution not implemented yet" };
  }
  throw new Error("Unsupported handler_type: " + tool.handler_type);
}
