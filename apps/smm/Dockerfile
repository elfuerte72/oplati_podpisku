# syntax=docker/dockerfile:1
# Образ SMM-бота для отдельного приложения Dokploy `oplatishka-smm`.
# Контекст сборки — КОРЕНЬ монорепозитория (lockfile один на workspace), поэтому
# в Dokploy указывается Dockerfile path `apps/smm/Dockerfile` и build context `.`.
#
# Бот не веб-сервис: порта не слушает, домена и роутера Traefik у него нет, наружу
# ходит сам (long polling Bot API). Поэтому ни EXPOSE, ни HEALTHCHECK — здоровье
# бот проверяет сам и пишет в тему «Ошибки» ops-группы (тикет 12).

# --- deps: установка только того, что нужно боту ---------------------------
FROM node:24-slim AS deps
WORKDIR /repo
# Версия pnpm закрепляется здесь же: corepack иначе тянет её на первом вызове и
# сборка зависит от того, что лежит в реестре в момент билда.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
# Сначала манифесты: слой переиспользуется, пока не меняется lockfile.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/smm/package.json apps/smm/
# `--filter smm...` тянет только зависимости бота: пакеты контура приложения
# (@oplati/*, next, react) в образ не попадают вовсе.
RUN pnpm install --frozen-lockfile --filter smm...

# --- build: tsc в dist + копирование промптов и миграций -------------------
FROM deps AS build
COPY apps/smm apps/smm
RUN pnpm --filter smm build
# Прод-зависимости отдельным деревом: dev-часть (vitest, eslint, typescript) в
# рантайм не едет.
RUN pnpm --filter smm --prod --frozen-lockfile deploy /bundle

# --- runtime ---------------------------------------------------------------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Non-root: у бота в томе лежит SQLite с перепиской и черновиками.
# Каталог создаётся и отдаётся пользователю ДО объявления тома: docker переносит
# владельца пустого ИМЕНОВАННОГО тома из образа.
# ⚠️ На bind-mount это правило не действует — каталог хоста останется root-овым,
# и открытие базы упадёт на правах. Поэтому в Dokploy том у бота обязан быть
# именованным (`smm-data`), а не привязкой каталога (тикет 15, шаг 1).
RUN mkdir -p /app/data /app/data/images && chown -R node:node /app/data
COPY --from=build --chown=node:node /bundle/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/smm/dist ./dist
COPY --from=build --chown=node:node /repo/apps/smm/package.json ./package.json
VOLUME ["/app/data"]
USER node
CMD ["node", "dist/main.js"]
