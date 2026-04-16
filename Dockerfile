FROM node:20-slim

RUN apt-get update && apt-get install -y git curl sudo jq && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# Create non-root user 'agent' so bypassPermissions mode works
RUN useradd -m -s /bin/bash -u 1001 agent && \
    mkdir -p /home/agent/.claude /workspace /publish /opt/mcp && \
    chown -R agent:agent /home/agent /workspace /publish /opt/mcp && \
    echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Copy the MCP server so Claude CLI can spawn it via --mcp-config
COPY mcp-server.js /opt/mcp/mcp-server.js
RUN chmod +x /opt/mcp/mcp-server.js && chown agent:agent /opt/mcp/mcp-server.js

USER agent
ENV HOME=/home/agent

WORKDIR /workspace

CMD ["tail", "-f", "/dev/null"]
