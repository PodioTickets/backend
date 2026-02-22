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
RUN pnpm install --prod --frozen-lockfile && \
    # Garante que o Prisma CLI e os engines sejam instalados corretamente
    pnpm prisma generate || true

# -----------------------------
# Production
# -----------------------------
FROM base AS production

ENV NODE_ENV=production
WORKDIR /usr/src/app

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

# Deps de runtime
COPY --from=prod-deps /usr/src/app/node_modules ./node_modules

# App buildado
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/prisma ./prisma

# Copia o client gerado que está dentro da estrutura virtual do pnpm
COPY --from=build /usr/src/app/node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client ./node_modules/.prisma/client

# Copia o pacote @prisma/client (necessário para o runtime)
COPY --from=build /usr/src/app/node_modules/.pnpm/@prisma+client*/node_modules/@prisma/client ./node_modules/@prisma/client

# Copia o Prisma CLI e os engines do stage de build (onde sabemos que funcionam)
# Isso garante que os binários estejam disponíveis para executar migrações
USER root
RUN mkdir -p ./node_modules/.pnpm
# Copia o diretório .pnpm inteiro do build (necessário para encontrar os diretórios corretos)
COPY --from=build /usr/src/app/node_modules/.pnpm /tmp/build-pnpm/
# Copia apenas os diretórios do Prisma e engines
RUN cd /tmp/build-pnpm && \
    for dir in prisma@* @prisma+engines@*; do \
      if [ -d "$dir" ]; then \
        cp -r "$dir" /usr/src/app/node_modules/.pnpm/ 2>/dev/null || true; \
      fi; \
    done && \
    rm -rf /tmp/build-pnpm

# Copia arquivos de configuração e script de entrada
COPY package.json ./
COPY docker-entrypoint.sh ./

# Configura permissões e formatação do script de entrada
RUN apk add --no-cache dos2unix && \
    dos2unix docker-entrypoint.sh && \
    apk del dos2unix && \
    chmod +x docker-entrypoint.sh && \
    mkdir -p uploads logs && \
    chown -R nestjs:nodejs /usr/src/app
USER nestjs

EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3333/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
