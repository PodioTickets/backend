# Como Executar Migrations no Docker

Este guia mostra diferentes formas de executar migrations do Prisma dentro do ambiente Docker.

## 📋 Pré-requisitos

1. Docker e Docker Compose instalados
2. Arquivo `.env` configurado com as variáveis de ambiente
3. Container do PostgreSQL rodando

## 🚀 Métodos para Executar Migrations

### Método 1: Usando Makefile (Recomendado - Mais Simples)

O projeto já tem comandos configurados no `Makefile`:

```bash
# Para produção (migrate deploy)
make migrate

# Para desenvolvimento (migrate dev - cria nova migration se necessário)
make migrate-dev
```

**O que faz:**
- `make migrate`: Executa `pnpm db:migrate deploy` dentro do container `backend`
- `make migrate-dev`: Executa `pnpm db:migrate` dentro do container `backend`

### Método 2: Executar Diretamente no Container

Se o container `backend` já estiver rodando:

```bash
# Para produção
docker-compose exec backend pnpm db:migrate deploy

# Para desenvolvimento
docker-compose exec backend pnpm db:migrate
```

**Nota:** Se o container não estiver rodando, use `docker-compose run`:

```bash
# Para produção
docker-compose run --rm backend pnpm db:migrate deploy

# Para desenvolvimento
docker-compose run --rm backend pnpm db:migrate
```

### Método 3: Usando Container Temporário

Se você não quiser subir o container completo, pode usar um container temporário:

```bash
# 1. Garantir que o PostgreSQL está rodando
docker-compose up -d postgres

# 2. Aguardar o banco estar pronto
sleep 10

# 3. Executar migration em container temporário
docker run --rm \
  -v $(pwd):/app \
  -w /app \
  --network podiogo_podiogo-network \
  -e DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public" \
  node:20-alpine sh -c "npm install -g pnpm && pnpm install && pnpm prisma migrate deploy"
```

**No Windows (PowerShell):**
```powershell
docker run --rm `
  -v ${PWD}:/app `
  -w /app `
  --network podiogo_podiogo-network `
  -e DATABASE_URL="postgresql://${env:POSTGRES_USER}:${env:POSTGRES_PASSWORD}@postgres:5432/${env:POSTGRES_DB}?schema=public" `
  node:20-alpine sh -c "npm install -g pnpm && pnpm install && pnpm prisma migrate deploy"
```

### Método 4: Entrar no Container e Executar Manualmente

```bash
# 1. Entrar no container
docker-compose exec backend sh

# 2. Dentro do container, executar:
pnpm db:migrate deploy
# ou
pnpm db:migrate
```

## 🔧 Comandos Úteis Relacionados

### Gerar Prisma Client

```bash
# Usando Makefile
make generate

# Diretamente
docker-compose exec backend pnpm db:generate
```

### Popular Slugs de Eventos

```bash
# Usando Makefile (se adicionar ao Makefile)
docker-compose exec backend pnpm db:populate-slugs

# Ou diretamente
docker-compose exec backend ts-node prisma/populate-event-slugs.ts
```

### Prisma Studio (Interface Visual)

```bash
# Usando Makefile
make studio

# Diretamente
docker-compose exec backend pnpm db:studio
```

**Nota:** Para acessar o Prisma Studio, você precisará fazer port forwarding:
```bash
docker-compose exec -p 5555:5555 backend pnpm db:studio
```

### Ver Status das Migrations

```bash
# Entrar no container e verificar
docker-compose exec backend sh
pnpm prisma migrate status
```

## 📝 Fluxo Completo: Aplicar Nova Migration

Quando você criar uma nova migration (como a de slug):

```bash
# 1. Garantir que os containers estão rodando
docker-compose up -d

# 2. Gerar Prisma Client (se necessário)
make generate
# ou
docker-compose exec backend pnpm db:generate

# 3. Aplicar migrations
make migrate
# ou
docker-compose exec backend pnpm db:migrate deploy

# 4. (Opcional) Popular slugs de eventos existentes
docker-compose exec backend pnpm db:populate-slugs
```

## 🐛 Troubleshooting

### Erro: "Can't reach database server"

**Causa:** O PostgreSQL não está rodando ou não está acessível.

**Solução:**
```bash
# Verificar se o PostgreSQL está rodando
docker-compose ps postgres

# Se não estiver, iniciar
docker-compose up -d postgres

# Aguardar alguns segundos e tentar novamente
sleep 10
make migrate
```

### Erro: "Migration already applied"

**Causa:** A migration já foi aplicada anteriormente.

**Solução:** Isso é normal. Se quiser verificar o status:
```bash
docker-compose exec backend pnpm prisma migrate status
```

### Erro: "Prisma Client not generated"

**Causa:** O Prisma Client precisa ser regenerado após mudanças no schema.

**Solução:**
```bash
make generate
# ou
docker-compose exec backend pnpm db:generate
```

### Container não está rodando

**Solução:**
```bash
# Iniciar todos os serviços
docker-compose up -d

# Ou apenas o PostgreSQL
docker-compose up -d postgres
```

## 📚 Comandos do Makefile Disponíveis

```bash
make help          # Mostra todos os comandos disponíveis
make migrate       # Executa migrations (deploy)
make migrate-dev   # Executa migrations (dev mode)
make generate      # Gera Prisma Client
make studio        # Abre Prisma Studio
make shell         # Abre shell no container
make logs          # Mostra logs
make ps            # Status dos containers
```

## ⚠️ Importante

- **Produção:** Use sempre `migrate deploy` (não cria novas migrations)
- **Desenvolvimento:** Use `migrate dev` (pode criar novas migrations)
- **Backup:** Sempre faça backup do banco antes de executar migrations em produção
- **Ordem:** Execute `db:generate` antes de `db:migrate` se o schema mudou

