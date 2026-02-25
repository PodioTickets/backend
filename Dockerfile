FROM node:20-alpine AS base

ENV PRISMA_CLI_BINARY_TARGETS=linux-musl

RUN apk add --no-cache \
    postgresql-client \
    openssl \
    netcat-openbsd

RUN npm install -g pnpm

WORKDIR /usr/src/app

# -----------------------------
# Dependencies (build deps)
# -----------------------------
FROM base AS dependencies

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# -----------------------------
# Build
# -----------------------------
FROM dependencies AS build

# Aumenta o limite de memória do Node.js para evitar "heap out of memory"
ENV NODE_OPTIONS=--max-old-space-size=4096

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src

# 🔑 Prisma Client PARA O BUILD
RUN pnpm prisma generate

RUN pnpm build
RUN ls -la dist/ && echo "--- Contents of dist ---" && find dist -type f | head -20

# -----------------------------
# Production deps only
# -----------------------------
FROM base AS prod-deps

COPY package.json pnpm-lock.yaml* ./
COPY prisma ./prisma
# Instala dependências de produção + Prisma CLI (como dev dependency para ter acesso aos binários)
# O Prisma precisa ser instalado para ter acesso aos binários (schema-engine, query-engine, etc.)
RUN pnpm install --prod --frozen-lockfile && \
    pnpm add -D prisma@^6.16.1 && \
    # Força o download dos binários do Prisma para a plataforma correta
    PRISMA_CLI_BINARY_TARGETS=linux-musl pnpm prisma generate || true && \
    # Verifica se os binários foram baixados
    find node_modules -name "schema-engine-linux-musl*" -o -name "query-engine-linux-musl*" | head -5 || echo "Binários não encontrados"

# -----------------------------
# Production
# -----------------------------
FROM base AS production

ENV NODE_ENV=production
WORKDIR /usr/src/app

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

# Deps de runtime (inclui Prisma CLI instalado como dev dependency)
COPY --from=prod-deps /usr/src/app/node_modules ./node_modules

# App buildado
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/prisma ./prisma

# Copia o client gerado que está dentro da estrutura virtual do pnpm
COPY --from=build /usr/src/app/node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client ./node_modules/.prisma/client

# Copia o pacote @prisma/client (necessário para o runtime)
COPY --from=build /usr/src/app/node_modules/.pnpm/@prisma+client*/node_modules/@prisma/client ./node_modules/@prisma/client

# Garante que o Prisma CLI e os engines estejam acessíveis
# O node_modules do prod-deps já inclui o Prisma, mas precisamos garantir que os binários estejam corretos
USER root
RUN chown -R nestjs:nodejs /usr/src/app/node_modules

# Copia arquivos de configuração e script de entrada
COPY package.json ./
COPY docker-entrypoint.sh ./

# Configura permissões e formatação do script de entrada
# Precisa ser root para executar apk
RUN apk add --no-cache dos2unix && \
    dos2unix docker-entrypoint.sh && \
    apk del dos2unix && \
    chmod +x docker-entrypoint.sh && \
    mkdir -p uploads logs && \
    chown -R nestjs:nodejs /usr/src/app

# Muda para usuário não-root antes de expor a porta
USER nestjs

EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3333/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
