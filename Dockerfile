# syntax=docker/dockerfile:1.4
FROM node:20-alpine AS base

ENV PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x \
    NODE_ENV=production

RUN apk add --no-cache \
    postgresql-client \
    openssl \
    netcat-openbsd \
    dos2unix \
    su-exec

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /usr/src/app

# -----------------------------
# Dependencies (cache layer)
# -----------------------------
FROM base AS dependencies

COPY package.json pnpm-lock.yaml* ./
# Cache do store pnpm entre builds (BuildKit na VPS / CI)
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

# -----------------------------
# Prisma generate (layer isolado — só roda quando o schema muda)
# -----------------------------
FROM dependencies AS prisma-generate

COPY prisma ./prisma
RUN pnpm prisma generate

# -----------------------------
# Build (só invalida quando src/* muda)
# -----------------------------
FROM prisma-generate AS build

# Em VPS pequena (ex.: 1 GB RAM) `4096` faz o Node/ts compiler disputar memória com o Docker e o kernel mata o processo ("signal: killed").
# Ajuste no compose ou: docker compose build --build-arg NODE_MAX_OLD_SPACE_SIZE=2048 backend
ARG NODE_MAX_OLD_SPACE_SIZE=768
ENV NODE_OPTIONS=--max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE}

COPY tsconfig.json tsconfig.build.json tsconfig.node.json nest-cli.json ./
COPY src ./src

# SWC em vez de tsc: bem mais rápido e usa menos RAM (crítico em VPS 1 vCPU / 1 GB).
RUN pnpm run build:docker

# -----------------------------
# Production
# -----------------------------
FROM base AS production

RUN apk add --no-cache openssl3 libc6-compat && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

# --chown no COPY evita RUN chown -R posterior, que duplica todos os inodes
# de node_modules em uma nova layer enorme (principal causa de lentidão)
COPY --chown=nestjs:nodejs --from=dependencies /usr/src/app/node_modules ./node_modules

# App buildado
COPY --chown=nestjs:nodejs --from=build /usr/src/app/dist ./dist
COPY --chown=nestjs:nodejs --from=build /usr/src/app/prisma ./prisma

# Prisma Client gerado (sobrescreve o vindo de dependencies)
COPY --chown=nestjs:nodejs --from=build /usr/src/app/node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client ./node_modules/.prisma/client
COPY --chown=nestjs:nodejs --from=build /usr/src/app/node_modules/.pnpm/@prisma+client*/node_modules/@prisma/client ./node_modules/@prisma/client

# Arquivos de configuração e scripts
COPY --chown=nestjs:nodejs package.json tsconfig.json tsconfig.node.json docker-entrypoint.sh ./
COPY --chown=nestjs:nodejs scripts ./scripts

# chmod apenas nos binários do Prisma (pequeno, sem chown -R node_modules)
RUN chmod +x node_modules/.prisma/client/libquery_engine-linux-musl* \
        node_modules/@prisma/engines/libquery_engine-linux-musl* \
        node_modules/@prisma/engines/migration-engine-linux-musl* \
        node_modules/@prisma/engines/introspection-engine-linux-musl* \
        node_modules/@prisma/engines/prisma-fmt-linux-musl* \
        2>/dev/null || true

RUN dos2unix docker-entrypoint.sh && \
    chmod +x docker-entrypoint.sh && \
    mkdir -p uploads logs && \
    chown nestjs:nodejs uploads logs

USER root

EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3333/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
