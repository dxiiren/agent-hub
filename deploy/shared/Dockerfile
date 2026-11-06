# One image for every developer container: Paseo daemon + the agent CLIs + tea. Versions are pinned (ARG).
FROM node:22-bookworm-slim
ARG PASEO_VERSION=0.15.2
ARG CODEX_VERSION=0.166.0
ARG CLAUDE_VERSION=2.1.318
ARG OPENCODE_VERSION=1.19.5
ARG QODER_VERSION=1.1.83
ARG QWEN_VERSION=0.26.7
ARG TEA_VERSION=0.9.2
# python3: agents search and run scripts; add the toolchains your team builds with (jdk, maven) here
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates procps python3 ripgrep \
 && rm -rf /var/lib/apt/lists/*
RUN npm i -g @getpaseo/cli@${PASEO_VERSION} @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_VERSION} \
      opencode-ai@${OPENCODE_VERSION} @qoder-ai/qodercli@${QODER_VERSION} @qwen-code/qwen-code@${QWEN_VERSION} \
 && npm cache clean --force
RUN curl -fsSL -o /usr/local/bin/tea https://dl.gitea.com/tea/${TEA_VERSION}/tea-${TEA_VERSION}-linux-amd64 && chmod +x /usr/local/bin/tea
# non-root; /home/paseo is the per-dev volume (Paseo home, agent worktrees and every CLI login)
RUN useradd -m -u 1500 paseo
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
USER paseo
ENV HOME=/home/paseo OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_TELEMETRY=1
ENTRYPOINT ["/entrypoint.sh"]
