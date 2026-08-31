#!/bin/sh
set -e

# Host/porta do banco: por padrão o Cloud SQL de homologação.
# Em ambiente local, o docker-compose.override.yml define POSTGRES_HOST=postgres.
DB_WAIT_HOST="${POSTGRES_HOST:-34.95.198.14}"
DB_WAIT_PORT="${POSTGRES_PORT:-5432}"

echo "⏳ Aguardando Postgres em ${DB_WAIT_HOST}:${DB_WAIT_PORT}..."

until pg_isready -h "$DB_WAIT_HOST" -p "$DB_WAIT_PORT" -U "$POSTGRES_USER"; do
  sleep 2
done

echo "✅ Postgres disponível"

echo "🔄 Executando migrações do banco de dados..."
pnpm prisma migrate deploy || {
  echo "⚠️  Aviso: Falha ao executar migrações. Continuando..."
}

# Garantir que o volume de uploads exista e tenha permissão para o usuário da app
mkdir -p /usr/src/app/uploads/images /usr/src/app/uploads/pdfs
chown -R nestjs:nodejs /usr/src/app/uploads 2>/dev/null || true

echo "🚀 Iniciando aplicação"
exec su-exec nestjs node dist/main.js
