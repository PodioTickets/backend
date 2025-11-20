#!/bin/bash
set -e

echo "🔄 Configurando Streaming Replication Real..."

# Variáveis
PGUSER="${POSTGRES_USER:-podiogo}"
PGPASSWORD="${POSTGRES_PASSWORD:-podiogo123}"
PGDATABASE="${POSTGRES_DB:-podiogo}"
REPLICA_USER="replicator"
REPLICA_PASSWORD="${REPLICA_PASSWORD:-replicator123}"
MASTER_HOST="postgres"
MASTER_PORT="5432"

# 1. Parar PostgreSQL no replica
echo "⏸️  Parando PostgreSQL no replica..."
pg_ctl -D /var/lib/postgresql/data/pgdata -m fast -w stop || true

# 2. Limpar dados antigos
echo "🗑️  Limpando dados antigos..."
rm -rf /var/lib/postgresql/data/pgdata/*

# 3. Fazer backup base do master usando pg_basebackup
echo "📦 Fazendo backup base do master..."
PGPASSWORD="${REPLICA_PASSWORD}" pg_basebackup \
  -h "${MASTER_HOST}" \
  -p "${MASTER_PORT}" \
  -U "${REPLICA_USER}" \
  -D /var/lib/postgresql/data/pgdata \
  -Fp \
  -Xs \
  -P \
  -R \
  -S replica_slot

if [ $? -ne 0 ]; then
  echo "⚠️  Tentando com usuário padrão..."
  PGPASSWORD="${PGPASSWORD}" pg_basebackup \
    -h "${MASTER_HOST}" \
    -p "${MASTER_PORT}" \
    -U "${PGUSER}" \
    -D /var/lib/postgresql/data/pgdata \
    -Fp \
    -Xs \
    -P \
    -R
fi

# 4. Configurar postgresql.conf para replica
echo "📝 Configurando postgresql.conf..."
cat >> /var/lib/postgresql/data/pgdata/postgresql.conf <<EOF

# Replication settings
hot_standby = on
max_standby_streaming_delay = 30s
wal_receiver_timeout = 60s
hot_standby_feedback = on
EOF

# 5. Configurar postgresql.auto.conf para recovery
echo "📝 Configurando postgresql.auto.conf..."
cat > /var/lib/postgresql/data/pgdata/postgresql.auto.conf <<EOF
primary_conninfo = 'host=${MASTER_HOST} port=${MASTER_PORT} user=${REPLICA_USER} password=${REPLICA_PASSWORD}'
primary_slot_name = 'replica_slot'
EOF

# 6. Criar arquivo standby.signal (PostgreSQL 12+)
echo "📝 Criando standby.signal..."
touch /var/lib/postgresql/data/pgdata/standby.signal

echo "✅ Streaming Replication configurado!"
echo "🚀 Iniciando PostgreSQL replica em modo standby..."

# 7. Iniciar PostgreSQL
exec postgres

