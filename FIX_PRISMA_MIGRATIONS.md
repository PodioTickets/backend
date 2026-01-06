# Solução: Erro "Could not find schema-engine binary"

## 🔍 Problema

O erro ocorre porque o container de produção não tem o Prisma CLI instalado (ele está em `devDependencies`), então os binários do Prisma não estão disponíveis.

## ✅ Soluções

### Solução 1: Usar Container Temporário (Recomendado)

Execute as migrations usando um container temporário que tem todas as dependências:

```bash
# 1. Garantir que o PostgreSQL está rodando
docker-compose up -d postgres

# 2. Executar migration em container temporário
docker run --rm \
  -v $(pwd):/app \
  -w /app \
  --network podiogo_podiogo-network \
  -e DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public" \
  node:20-alpine sh -c "npm install -g pnpm && pnpm install && pnpm prisma migrate deploy"
```

**No servidor Ubuntu:**
```bash
cd /srv/backend
docker run --rm \
  -v $(pwd):/app \
  -w /app \
  --network podiogo_podiogo-network \
  -e DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public" \
  node:20-alpine sh -c "npm install -g pnpm && pnpm install && pnpm prisma migrate deploy"
```

### Solução 2: Instalar Prisma no Container de Produção

Modifique o Dockerfile para incluir o Prisma CLI no container de produção:

```dockerfile
# No stage "prod-deps", adicione prisma:
FROM base AS prod-deps

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile && \
    pnpm add -g prisma@^6.16.1
```

**Ou adicione prisma como dependência de produção** (não recomendado, aumenta o tamanho da imagem):

```json
// package.json
"dependencies": {
  ...
  "prisma": "^6.16.1"
}
```

### Solução 3: Rebuild do Container com Prisma

Se você quiser manter o Prisma no container, faça rebuild:

```bash
# 1. Parar containers
docker-compose down

# 2. Rebuild sem cache
docker-compose build --no-cache

# 3. Subir novamente
docker-compose up -d

# 4. Executar migrations
docker-compose exec backend pnpm prisma migrate deploy
```

## 🚀 Solução Rápida (Recomendada para Produção)

### Opção A: Descobrir o nome correto da rede

```bash
# 1. Verificar o nome real da rede
docker network ls | grep podiogo

# 2. Usar o nome encontrado no comando abaixo
```

### Opção B: Usar o nome do container diretamente (Mais Simples)

```bash
# No servidor, execute:
cd /srv/backend

# Carregar variáveis do .env
export $(grep -v '^#' .env | xargs)

# Executar migration conectando ao container do postgres
docker run --rm \
  -v $(pwd):/app \
  -w /app \
  --network container:podiogo-postgres \
  -e DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/${POSTGRES_DB}?schema=public" \
  node:20-alpine sh -c "npm install -g pnpm && pnpm install && pnpm prisma migrate deploy"
```

### Opção C: Garantir que os containers estão rodando primeiro

```bash
# 1. Subir os containers (isso cria a rede automaticamente)
docker-compose up -d postgres

# 2. Descobrir o nome da rede
NETWORK_NAME=$(docker inspect podiogo-postgres | grep -A 10 "Networks" | grep -oP '"\K[^"]+_podiogo-network' | head -1)

# 3. Executar migration
docker run --rm \
  -v $(pwd):/app \
  -w /app \
  --network ${NETWORK_NAME:-podiogo_podiogo-network} \
  -e DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public" \
  node:20-alpine sh -c "npm install -g pnpm && pnpm install && pnpm prisma migrate deploy"
```

### Opção D: Usar host.docker.internal (se postgres estiver acessível na porta 5432 do host)

```bash
# Se o PostgreSQL está exposto na porta 5432 do host
docker run --rm \
  -v $(pwd):/app \
  -w /app \
  -e DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@host.docker.internal:5432/${POSTGRES_DB}?schema=public" \
  node:20-alpine sh -c "npm install -g pnpm && pnpm install && pnpm prisma migrate deploy"
```

## 📝 Adicionar ao Makefile

Você pode adicionar este comando ao Makefile:

```makefile
migrate-temp: ## Executa migrações usando container temporário
	@echo "Executando migrations em container temporário..."
	docker run --rm \
		-v $$(pwd):/app \
		-w /app \
		--network podiogo_podiogo-network \
		-e DATABASE_URL="postgresql://$${POSTGRES_USER}:$${POSTGRES_PASSWORD}@postgres:5432/$${POSTGRES_DB}?schema=public" \
		node:20-alpine sh -c "npm install -g pnpm && pnpm install && pnpm prisma migrate deploy"
```

Então use: `make migrate-temp`

## ⚠️ Nota Importante

O Prisma CLI não é necessário no container de produção para a aplicação rodar. O Prisma Client (que é usado pela aplicação) já está sendo gerado e copiado no build. O CLI só é necessário para executar migrations, então usar um container temporário é a melhor prática.

