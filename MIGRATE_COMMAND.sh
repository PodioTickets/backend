#!/bin/bash
# Script para executar migrations do Prisma no Docker

cd /srv/backend

# Carregar variáveis do .env
export $(grep -v '^#' .env | xargs)

# Garantir que o PostgreSQL está rodando
echo "Verificando se o PostgreSQL está rodando..."
docker-compose up -d postgres

# Aguardar o PostgreSQL estar pronto
echo "Aguardando PostgreSQL estar pronto..."
sleep 5

# Descobrir o nome da rede
NETWORK_NAME=$(docker inspect podiogo-postgres 2>/dev/null | grep -A 20 '"Networks"' | grep -oP '"\K[^"]+_podiogo-network' | head -1)

if [ -z "$NETWORK_NAME" ]; then
    # Tentar descobrir pelo nome do diretório
    NETWORK_NAME=$(docker network ls | grep podiogo | awk '{print $2}' | head -1)
fi

if [ -z "$NETWORK_NAME" ]; then
    # Usar nome padrão
    NETWORK_NAME="podiogo_podiogo-network"
fi

echo "Usando rede: $NETWORK_NAME"

# Executar migration
docker run --rm \
  -v $(pwd):/app \
  -w /app \
  --network $NETWORK_NAME \
  -e DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public" \
  node:20-alpine sh -c "npm install -g pnpm && pnpm install && pnpm prisma migrate deploy"

echo "✅ Migration concluída!"

