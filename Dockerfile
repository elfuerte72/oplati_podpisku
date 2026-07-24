# syntax=docker/dockerfile:1
# Self-host образ apps/web для Dokploy (docs/dokploy-migration-plan.md, Фаза 1.2).
# Vercel этот файл игнорирует — на прод-деплой Vercel не влияет.
#
# Три стадии: deps (кэшируемая установка по lockfile) → build (next build,
# standalone) → runner (минимальный рантайм без dev-зависимостей и исходников).

# --- deps: установка зависимостей всего workspace -------------------------
FROM node:24-slim AS deps
WORKDIR /app
# pnpm версии из package.json#packageManager (corepack читает поле сам)
RUN corepack enable
# Только манифесты: слой переиспользуется, пока не меняется lockfile
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/web/package.json apps/web/
COPY packages/types/package.json packages/types/
COPY packages/db/package.json packages/db/
COPY packages/agent/package.json packages/agent/
RUN pnpm install --frozen-lockfile

# --- build: next build (output: standalone) -------------------------------
FROM deps AS build
# node_modules уже в образе; .dockerignore исключает их из контекста,
# поэтому COPY не затирает установленное
COPY . .
# Единственная NEXT_PUBLIC_* проекта — запекается в клиентский бандл на билде
ARG NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_TELEMETRY_DISABLED=1
# serverEnv — lazy (apps/web/lib/env.ts): билд не требует боевых секретов
RUN pnpm --filter web build

# --- runner: минимальный рантайм ------------------------------------------
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
# Non-root (конвенция безопасности; см. CLAUDE.md про PII/платёжный код)
RUN groupadd --system nodejs && useradd --system --gid nodejs nextjs
# Standalone-выход монорепо сохраняет структуру apps/web внутри
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3000
# Liveness — /api/health (без БД, см. route). node fetch вместо curl:
# в slim-образе curl/wget нет, а ставить ради healthcheck не хотим.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
