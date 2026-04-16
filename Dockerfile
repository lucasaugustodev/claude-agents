FROM node:20-slim

RUN apt-get update && apt-get install -y git curl sudo && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# Create non-root user 'agent' so bypassPermissions mode works
RUN useradd -m -s /bin/bash -u 1001 agent && \
    mkdir -p /home/agent/.claude /workspace /publish && \
    chown -R agent:agent /home/agent /workspace /publish && \
    echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER agent
ENV HOME=/home/agent

WORKDIR /workspace

CMD ["tail", "-f", "/dev/null"]
