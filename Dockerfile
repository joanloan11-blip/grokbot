FROM node:22-bookworm-slim

WORKDIR /app

# ffmpeg перекодирует голосовые записи браузера для whisper.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY examples ./examples
COPY README.md ./

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @mayak/web build \
  && pnpm --filter @mayak/server build

ENV HOST=0.0.0.0 \
    PORT=8787 \
    NODE_ENV=production \
    STATIC_DIR=/app/apps/web/dist \
    DATA_DIR=/app/data \
    MAYAK_DEMO_SERVER=/app/examples/demo-mcp-server/dist/index.mjs

EXPOSE 8787

CMD ["node", "apps/server/dist/index.js"]
