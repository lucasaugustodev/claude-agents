#!/usr/bin/env python3
path = "/opt/claude-agents/server.js"
with open(path, "r", encoding="utf-8") as f:
    src = f.read()

old = '''function buildPublishInstructions(groupId, agentPort, subdomain) {
  const hostIp = getHostIp();
  const containerName = GROUP_PREFIX + groupId;
  return `

=== AGENTSFY DEPLOY SYSTEM ===

You are inside a Docker container named "${containerName}" that is part of the Agentsfy platform.
All agents in this group share the /workspace filesystem and /publish directory.
Your dedicated port is ${agentPort}.

WHEN YOU BUILD AN APP OR WEBSITE, YOU MUST FOLLOW THIS FULL DEPLOY PROCESS:

STEP 1 - Build your app
  Save files to /publish/ for static sites, or create a server in /workspace.

STEP 2 - Start serving
  For static sites:
    npm install -g serve 2>/dev/null; serve /publish -l ${agentPort} -s &
  For Node.js apps:
    Start your server listening on port ${agentPort}

STEP 3 - Register the app (MANDATORY)
  This makes the app appear on the user's Apps page in Agentsfy:
    curl -s -X POST http://127.0.0.1:9090/containers/${containerName}/apps \\\\
      -H "Content-Type: application/json" -H "x-api-key: ${CLOUD_API_SECRET}" \\\\
      -d '{"app_name":"${subdomain}","port":${agentPort},"command":"serve /publish -l ${agentPort} -s"}'

STEP 4 - Register subdomain (MANDATORY)
  This gives the app a production HTTPS URL:
    curl -s -X POST http://127.0.0.1:9090/subdomains \\\\
      -H "Content-Type: application/json" -H "x-api-key: ${CLOUD_API_SECRET}" \\\\
      -d '{"subdomain":"${subdomain}","container_name":"${containerName}","port":${agentPort},"ip":"127.0.0.1"}'

STEP 5 - Confirm to the user
  Production URL: https://${subdomain}.${DOMAIN}
  ALWAYS tell the user this URL after deploying.

IMPORTANT RULES:
- NEVER skip steps 3 and 4. Without them the app won't appear in the platform.
- If the user asks to "deploy", "publish", or "put online", follow ALL 5 steps.
- Use /workspace/shared/ for files that other agents in this group need to access.
- Your personal workspace is /workspace/<your-name> but you can read/write anywhere in /workspace.

=== CREDENTIALS ===
User API keys and credentials are stored in /workspace/shared/credentials.json
Read this file when you need API keys, tokens, or secrets for external services (Bitrix, GitHub, etc).
Format: {"key_name": "key_value", ...}
NEVER hardcode credentials. Always read from this file.

=== END SYSTEM ===
`;
}'''

new = '''function buildPublishInstructions(groupId, agentPort, subdomain) {
  const containerName = GROUP_PREFIX + groupId;
  return `
You are part of the Agentsfy platform running inside Docker container "${containerName}".
Your dedicated port is ${agentPort}.

=== TOOLS ===
Always read your context first:
  cat /workspace/shared/context.json
  # Contains api_url, api_token, conversation_id, user_id, group_members

Invoke any platform tool with:
  API_URL=$(jq -r .api_url /workspace/shared/context.json)
  API_TOKEN=$(jq -r .api_token /workspace/shared/context.json)
  CONV_ID=$(jq -r .conversation_id /workspace/shared/context.json)

  curl -s -X POST $API_URL/api/tools/<tool_name> \\\\
    -H "x-api-token: $API_TOKEN" \\\\
    -H "Content-Type: application/json" \\\\
    -d '{"conversation_id": "'$CONV_ID'", ...other args}'

Discover available tools:
  curl -s $API_URL/api/tools | jq

Key tools:
- schedule_create: recurring tasks (cron)
- schedule_list / schedule_delete: manage recurring tasks
- deploy_app: publish to production subdomain (https://${subdomain}.${DOMAIN})
- credential_get: fetch user credentials (use this instead of hardcoding keys)
- memory_search / memory_store: persistent memory
- github_create_repo: GitHub operations
- project_file_read / project_file_write: user cloud container files

=== WORKSPACE ===
Shared filesystem: /workspace (all agents in group)
Publish dir: /publish (auto-served)
Credentials: /workspace/shared/credentials.json (read from here, never hardcode)

When user asks for recurring tasks ("a cada X min", "diariamente"), use schedule_create tool.
When user asks to deploy/publish, use deploy_app tool.
`;
}'''

if old not in src:
    print("ERROR: buildPublishInstructions block not found")
    raise SystemExit(1)
src = src.replace(old, new)

with open(path, "w", encoding="utf-8") as f:
    f.write(src)
print("OK")
