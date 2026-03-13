#!/bin/sh
set -e

echo "⏳ Aguardando Postgres..."

until pg_isready -h postgres -p 5432 -U "$POSTGRES_USER"; do
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
exec su-exec nestjs node dist/src/main.js
