#!/bin/bash
set -e

echo "🔄 Initializing PostgreSQL Read Replica..."

# Aguardar o master estar pronto
until PGPASSWORD="${POSTGRES_PASSWORD}" psql -h postgres -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c '\q' 2>/dev/null; do
  echo "Waiting for master PostgreSQL..."
  sleep 2
done

echo "✅ Master PostgreSQL is ready!"

# Por enquanto, vamos criar um banco de dados simples para testes
# Em produção, você configuraria replicação real via streaming replication
# Este é um setup simplificado para desenvolvimento/testes

echo "📝 Note: This is a simplified replica setup for testing."
echo "📝 For production, configure proper streaming replication."

# Criar estrutura do banco (schema será criado via migrations)
PGPASSWORD="${POSTGRES_PASSWORD}" psql -h postgres -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "
CREATE PUBLICATION podiogo_publication FOR ALL TABLES;
" 2>/dev/null || echo "Publication may already exist"

echo "✅ Replica initialization completed!"

