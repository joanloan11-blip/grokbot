FROM node:22-bookworm-slim

WORKDIR /app

# ffmpeg перекодирует голосовые записи браузера для whisper.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

# Образ обслуживает веб и сервер; Electron нужен только для сборки десктопа в CI.
# Без этого флага pnpm install тянет ~100 МБ бинарников Electron при каждой сборке.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY examples ./examples
COPY README.md ./
COPY docs ./docs

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
