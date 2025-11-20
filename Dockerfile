# Multi-stage build para otimizar tamanho da imagem
FROM node:20-alpine AS base

# Instalar dependências do sistema necessárias
RUN apk add --no-cache \
    postgresql-client \
    openssl \
    netcat-openbsd

# Instalar pnpm globalmente
RUN npm install -g pnpm

# Stage 1: Dependencies
FROM base AS dependencies
WORKDIR /usr/src/app

# Copiar arquivos de dependências
COPY package.json pnpm-lock.yaml* ./

# Instalar dependências (incluindo devDependencies para build)
RUN pnpm install --frozen-lockfile

# Stage 2: Build
FROM dependencies AS build
WORKDIR /usr/src/app

# Copiar arquivos de configuração necessários para build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma/

# Copiar código fonte
COPY src ./src

# Gerar Prisma Client
RUN pnpm db:generate

# Build da aplicação
RUN pnpm build

# Stage 3: Production
FROM base AS production
WORKDIR /usr/src/app

# Criar usuário não-root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

# Copiar apenas arquivos necessários
COPY --from=dependencies /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/prisma ./prisma
COPY package.json pnpm-lock.yaml* ./

# Copiar script de entrada ANTES de gerar Prisma Client
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && \
    sed -i 's/\r$//' docker-entrypoint.sh || true

# Gerar Prisma Client no stage de produção (necessário para runtime)
# Deve ser feito antes de mudar para usuário não-root
RUN pnpm db:generate

# Criar diretório para uploads e logs
RUN mkdir -p uploads logs && chown -R nestjs:nodejs /usr/src/app

# Mudar para usuário não-root
USER nestjs

# Expor porta
EXPOSE 3333

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3333/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Usar script de entrada
ENTRYPOINT ["./docker-entrypoint.sh"]
