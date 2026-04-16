#!/usr/bin/env python3
import re

path = "/opt/agentify-v2/src/routes/group-chats.ts"
with open(path, "r", encoding="utf-8") as f:
    src = f.read()

# === FIRST BLOCK (create group) ===
# Insert context.json write AFTER the initial credentials injection
old_first = '''    // Auto-inject user credentials into group container
    try {
      const { data: userSecrets } = await supabase
        .from("user_secrets")
        .select("name, credential")
        .eq("user_id", userId);

      if (userSecrets && userSecrets.length > 0) {
        const credsMap: Record<string, string> = {};
        for (const s of userSecrets) {
          credsMap[s.name] = s.credential;
        }
        // Write credentials to container via claude-agents exec
        const containerName = "claude-group-" + claudeGroupId;
        const credsB64 = Buffer.from(JSON.stringify(credsMap, null, 2)).toString("base64");
        await callClaudeAgentsAPI(`/groups/${claudeGroupId}/exec`, {
          method: "POST",
          body: JSON.stringify({
            command: `mkdir -p /workspace/shared && echo ${credsB64} | base64 -d > /workspace/shared/credentials.json`,
          }),
        });
      }
    } catch (credErr: any) {
      app.log.warn({ credErr }, "Failed to inject user credentials into group container");
    }'''

new_first = '''    // Auto-inject user credentials + context into group container
    try {
      const { data: userSecrets } = await supabase
        .from("user_secrets")
        .select("name, credential")
        .eq("user_id", userId);

      if (userSecrets && userSecrets.length > 0) {
        const credsMap: Record<string, string> = {};
        for (const s of userSecrets) {
          credsMap[s.name] = s.credential;
        }
        // Write credentials to container via claude-agents exec
        const credsB64 = Buffer.from(JSON.stringify(credsMap, null, 2)).toString("base64");
        await callClaudeAgentsAPI(`/groups/${claudeGroupId}/exec`, {
          method: "POST",
          body: JSON.stringify({
            command: `mkdir -p /workspace/shared && echo ${credsB64} | base64 -d > /workspace/shared/credentials.json`,
          }),
        });
      }

      // Get or create user API token, then write context.json for the tool registry
      const { data: tokRow } = await supabase.from("user_api_tokens").select("token").eq("user_id", userId).maybeSingle();
      let apiToken = tokRow?.token;
      if (!apiToken) {
        const { randomBytes } = await import("node:crypto");
        apiToken = "at_" + randomBytes(24).toString("hex");
        await supabase.from("user_api_tokens").insert({ user_id: userId, token: apiToken });
      }
      const context = {
        api_url: "http://" + (process.env.AGENTIFY_INTERNAL_HOST || "172.17.0.1") + ":4001",
        api_token: apiToken,
        conversation_id: convId,
        user_id: userId,
        group_members: groupConfig?.members || [],
      };
      const ctxB64 = Buffer.from(JSON.stringify(context, null, 2)).toString("base64");
      await callClaudeAgentsAPI(`/groups/${claudeGroupId}/exec`, {
        method: "POST",
        body: JSON.stringify({
          command: `mkdir -p /workspace/shared && echo ${ctxB64} | base64 -d > /workspace/shared/context.json`,
        }),
      }).catch(() => {});
    } catch (credErr: any) {
      app.log.warn({ credErr }, "Failed to inject user credentials/context into group container");
    }'''

if old_first not in src:
    print("ERROR: first block not found")
    raise SystemExit(1)
src = src.replace(old_first, new_first)

# === SECOND BLOCK (refresh during turn) ===
old_second = '''      // 3.4 Refresh user credentials in container (picks up newly added keys)
      try {
        const { data: freshSecrets } = await supabase
          .from("user_secrets")
          .select("name, credential")
          .eq("user_id", userId);

        if (freshSecrets && freshSecrets.length > 0) {
          const credsMap: Record<string, string> = {};
          for (const s of freshSecrets) {
            credsMap[s.name] = s.credential;
          }
          const activeGroupId = groupConfig?.claude_group_id || claudeGroupId;
          const credsB64 = Buffer.from(JSON.stringify(credsMap, null, 2)).toString("base64");
          await callClaudeAgentsAPI(`/groups/${activeGroupId}/exec`, {
            method: "POST",
            body: JSON.stringify({
              command: `mkdir -p /workspace/shared && echo ${credsB64} | base64 -d > /workspace/shared/credentials.json`,
            }),
          }).catch(() => {});
        }
      } catch {}'''

new_second = '''      // 3.4 Refresh user credentials + context in container (picks up newly added keys)
      try {
        const { data: freshSecrets } = await supabase
          .from("user_secrets")
          .select("name, credential")
          .eq("user_id", userId);

        const activeGroupId = groupConfig?.claude_group_id || claudeGroupId;

        if (freshSecrets && freshSecrets.length > 0) {
          const credsMap: Record<string, string> = {};
          for (const s of freshSecrets) {
            credsMap[s.name] = s.credential;
          }
          const credsB64 = Buffer.from(JSON.stringify(credsMap, null, 2)).toString("base64");
          await callClaudeAgentsAPI(`/groups/${activeGroupId}/exec`, {
            method: "POST",
            body: JSON.stringify({
              command: `mkdir -p /workspace/shared && echo ${credsB64} | base64 -d > /workspace/shared/credentials.json`,
            }),
          }).catch(() => {});
        }

        // Refresh context.json with api_token for tool registry access
        const { data: tokRow } = await supabase.from("user_api_tokens").select("token").eq("user_id", userId).maybeSingle();
        let apiToken = tokRow?.token;
        if (!apiToken) {
          const { randomBytes } = await import("node:crypto");
          apiToken = "at_" + randomBytes(24).toString("hex");
          await supabase.from("user_api_tokens").insert({ user_id: userId, token: apiToken });
        }
        const context = {
          api_url: "http://" + (process.env.AGENTIFY_INTERNAL_HOST || "172.17.0.1") + ":4001",
          api_token: apiToken,
          conversation_id: id,
          user_id: userId,
          group_members: groupConfig?.members || [],
        };
        const ctxB64 = Buffer.from(JSON.stringify(context, null, 2)).toString("base64");
        await callClaudeAgentsAPI(`/groups/${activeGroupId}/exec`, {
          method: "POST",
          body: JSON.stringify({
            command: `mkdir -p /workspace/shared && echo ${ctxB64} | base64 -d > /workspace/shared/context.json`,
          }),
        }).catch(() => {});
      } catch {}'''

if old_second not in src:
    print("ERROR: second block not found")
    raise SystemExit(1)
src = src.replace(old_second, new_second)

with open(path, "w", encoding="utf-8") as f:
    f.write(src)
print("OK")
