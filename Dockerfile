FROM node:20-slim

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN mkdir -p /root/.claude

WORKDIR /workspace

CMD ["tail", "-f", "/dev/null"]
