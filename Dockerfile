FROM node:20-alpine AS base

ENV PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x \
    NODE_ENV=production

RUN apk add --no-cache \
    postgresql-client \
    openssl \
    netcat-openbsd \
    dos2unix

RUN npm install -g pnpm

WORKDIR /usr/src/app

# -----------------------------
# Dependencies (cache layer)
# -----------------------------
FROM base AS dependencies

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# -----------------------------
# Build
# -----------------------------
FROM dependencies AS build

ENV NODE_OPTIONS=--max-old-space-size=4096



COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src

RUN pnpm prisma generate && \
    pnpm build

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
RUN find node_modules -name "*engine-linux-musl*" -type f -exec chmod +x {} \; 2>/dev/null || true && \
    chown -R nestjs:nodejs /usr/src/app/node_modules

# Copia arquivos de configuração
COPY package.json docker-entrypoint.sh ./

# Configura script de entrada
RUN dos2unix docker-entrypoint.sh && \
    chmod +x docker-entrypoint.sh && \
    mkdir -p uploads logs && \
    chown -R nestjs:nodejs /usr/src/app

USER nestjs

EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3333/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
