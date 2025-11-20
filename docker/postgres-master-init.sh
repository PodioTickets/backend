#!/bin/bash
set -e

echo "🔄 Configurando PostgreSQL Streaming Replication..."

# Variáveis
PGUSER="${POSTGRES_USER:-podiogo}"
PGPASSWORD="${POSTGRES_PASSWORD:-podiogo123}"
PGDATABASE="${POSTGRES_DB:-podiogo}"
REPLICA_USER="replicator"
REPLICA_PASSWORD="${REPLICA_PASSWORD:-replicator123}"

# Esperar o master estar pronto
until PGPASSWORD="${PGPASSWORD}" psql -h postgres -U "${PGUSER}" -d "${PGDATABASE}" -c '\q' 2>/dev/null; do
  echo "⏳ Aguardando PostgreSQL master..."
  sleep 2
done

echo "✅ PostgreSQL master está pronto!"

# Criar usuário de replicação no master
PGPASSWORD="${PGPASSWORD}" psql -h postgres -U "${PGUSER}" -d "${PGDATABASE}" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_user WHERE usename = '${REPLICA_USER}') THEN
      CREATE USER ${REPLICA_USER} REPLICATION LOGIN PASSWORD '${REPLICA_PASSWORD}';
    END IF;
  END
  \$\$;
EOSQL

echo "✅ Usuário de replicação criado no master"

# Configurar pg_hba.conf para permitir conexões de replicação
# Nota: Em Docker, isso precisa ser feito via variáveis de ambiente ou arquivo de configuração
# Por enquanto, vamos usar trust para desenvolvimento (NÃO USAR EM PRODUÇÃO)
echo "host replication ${REPLICA_USER} 0.0.0.0/0 md5" >> /var/lib/postgresql/data/pg_hba.conf || true

# Criar slot de replicação
PGPASSWORD="${PGPASSWORD}" psql -h postgres -U "${PGUSER}" -d "${PGDATABASE}" <<-EOSQL
  SELECT pg_create_physical_replication_slot('replica_slot', true);
EOSQL 2>/dev/null || echo "ℹ️  Slot de replicação pode já existir"

echo "✅ Slot de replicação criado"

# Recarregar configuração do PostgreSQL
PGPASSWORD="${PGPASSWORD}" psql -h postgres -U "${PGUSER}" -d "${PGDATABASE}" -c "SELECT pg_reload_conf();" || true

echo "✅ Streaming Replication configurado no master!"
echo ""
echo "📝 Para configurar o replica, execute:"
echo "   docker exec -it podiogo-postgres-replica /docker-entrypoint-initdb.d/setup-replica.sh"

