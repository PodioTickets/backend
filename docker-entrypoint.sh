#!/bin/sh
set -e

echo "⏳ Aguardando Postgres..."

until pg_isready -h postgres -p 5432 -U "$POSTGRES_USER"; do
  sleep 2
done

echo "✅ Postgres disponível"

echo "📦 Rodando migrations..."
npx prisma migrate deploy

echo "🚀 Iniciando aplicação"
exec node dist/main.js
