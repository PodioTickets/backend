#!/bin/sh
set -e

echo "🚀 Starting PodioGo Server..."

# Função para aguardar PostgreSQL usando TCP check simples
wait_for_postgres() {
  echo "⏳ Waiting for PostgreSQL to be ready..."
  until nc -z postgres 5432 2>/dev/null; do
    echo "PostgreSQL is unavailable - sleeping"
    sleep 2
  done
  echo "✅ PostgreSQL is ready!"
}

# Aguardar PostgreSQL estar pronto
wait_for_postgres

# Aguardar um pouco mais para garantir que está totalmente pronto
sleep 2

# Gerar Prisma Client se necessário
if [ ! -d "node_modules/.prisma" ]; then
  echo "📦 Generating Prisma Client..."
  pnpm db:generate
fi

# Executar migrações
echo "🔄 Running database migrations..."
if pnpm db:migrate:deploy 2>/dev/null; then
  echo "✅ Migrations applied successfully!"
else
  echo "⚠️  Migrate deploy failed, trying db:push..."
  pnpm db:push || echo "⚠️  db:push also failed, continuing anyway..."
fi

echo "✅ Setup completed!"

# Iniciar aplicação baseada no NODE_ENV
echo "🎯 Starting application..."
if [ "$NODE_ENV" = "development" ]; then
  echo "🚀 Starting in DEVELOPMENT mode with hot reload..."
  exec pnpm dev
else
  echo "🏭 Starting in PRODUCTION mode..."
  exec node dist/main
fi



