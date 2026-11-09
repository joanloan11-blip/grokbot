# Песочница QASTOM AGENT: запускает команды агентов в их рабочих папках.
FROM node:22-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-pip python3-venv ripgrep procps jq \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /runner
COPY server.mjs ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
