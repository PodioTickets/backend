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
# Build
# -----------------------------
FROM dependencies AS build

# Em VPS pequena (ex.: 1 GB RAM) `4096` faz o Node/ts compiler disputar memória com o Docker e o kernel mata o processo ("signal: killed").
# Ajuste no compose ou: docker compose build --build-arg NODE_MAX_OLD_SPACE_SIZE=2048 backend
ARG NODE_MAX_OLD_SPACE_SIZE=768
ENV NODE_OPTIONS=--max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE}

COPY tsconfig.json tsconfig.build.json tsconfig.node.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src

# SWC em vez de tsc: bem mais rápido e usa menos RAM (crítico em VPS 1 vCPU / 1 GB).
RUN pnpm prisma generate && \
    pnpm run build:docker

# -----------------------------
# Production
# -----------------------------
FROM base AS production

RUN apk add --no-cache openssl3 libc6-compat

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

# Copia dependências (inclui Prisma CLI para migrações)
COPY --from=dependencies /usr/src/app/node_modules ./node_modules

# App buildado
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/prisma ./prisma

# Copia Prisma Client gerado
COPY --from=build /usr/src/app/node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client ./node_modules/.prisma/client
COPY --from=build /usr/src/app/node_modules/.pnpm/@prisma+client*/node_modules/@prisma/client ./node_modules/@prisma/client

# Garante que os binários do Prisma estejam executáveis
USER root
RUN chmod +x node_modules/.prisma/client/libquery_engine-linux-musl* \
        node_modules/@prisma/engines/libquery_engine-linux-musl* \
        node_modules/@prisma/engines/migration-engine-linux-musl* \
        node_modules/@prisma/engines/introspection-engine-linux-musl* \
        node_modules/@prisma/engines/prisma-fmt-linux-musl* \
        2>/dev/null || true && \
    chown -R nestjs:nodejs /usr/src/app/node_modules

# Copia arquivos de configuração
COPY package.json docker-entrypoint.sh tsconfig.json tsconfig.node.json ./

# Utility scripts (sandbox/debug tooling)
COPY scripts ./scripts

# Configura script de entrada (entrypoint roda como root para chown do volume uploads)
RUN dos2unix docker-entrypoint.sh && \
    chmod +x docker-entrypoint.sh && \
    mkdir -p uploads logs && \
    chown -R nestjs:nodejs /usr/src/app

USER root

EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3333/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
