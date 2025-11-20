#!/bin/bash
set -e

echo "🔄 Configurando PostgreSQL Read Replica..."

# Variáveis
PGUSER="${POSTGRES_USER:-podiogo}"
PGPASSWORD="${POSTGRES_PASSWORD:-podiogo123}"
PGDATABASE="${POSTGRES_DB:-podiogo}"
REPLICA_USER="replicator"
REPLICA_PASSWORD="${REPLICA_PASSWORD:-replicator123}"
MASTER_HOST="postgres"
MASTER_PORT="5432"

# Esperar o master estar pronto
until PGPASSWORD="${PGPASSWORD}" psql -h "${MASTER_HOST}" -U "${PGUSER}" -d "${PGDATABASE}" -c '\q' 2>/dev/null; do
  echo "⏳ Aguardando PostgreSQL master..."
  sleep 2
done

echo "✅ PostgreSQL master está pronto!"

# Parar o PostgreSQL se estiver rodando
pg_ctl -D /var/lib/postgresql/data/pgdata -m fast -w stop || true

# Limpar dados antigos (apenas na primeira execução)
if [ ! -f /var/lib/postgresql/data/pgdata/.replica_configured ]; then
  echo "🗑️  Limpando dados antigos do replica..."
  rm -rf /var/lib/postgresql/data/pgdata/*
  
  # Fazer backup base do master
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
    -S replica_slot || {
      echo "⚠️  Não foi possível usar streaming replication. Usando método alternativo..."
      PGPASSWORD="${PGPASSWORD}" pg_basebackup \
        -h "${MASTER_HOST}" \
        -p "${MASTER_PORT}" \
        -U "${PGUSER}" \
        -D /var/lib/postgresql/data/pgdata \
        -Fp \
        -Xs \
        -P || true
    }
  
  touch /var/lib/postgresql/data/pgdata/.replica_configured
fi

# Configurar postgresql.conf para replica
cat >> /var/lib/postgresql/data/pgdata/postgresql.conf <<EOF

# Replication settings
hot_standby = on
max_standby_streaming_delay = 30s
wal_receiver_timeout = 60s
hot_standby_feedback = on
EOF

# Configurar recovery.conf ou postgresql.auto.conf
cat > /var/lib/postgresql/data/pgdata/postgresql.auto.conf <<EOF
primary_conninfo = 'host=${MASTER_HOST} port=${MASTER_PORT} user=${REPLICA_USER} password=${REPLICA_PASSWORD}'
primary_slot_name = 'replica_slot'
EOF

# Criar arquivo standby.signal (PostgreSQL 12+)
touch /var/lib/postgresql/data/pgdata/standby.signal

echo "✅ Replica configurado!"

# Iniciar o PostgreSQL
echo "🚀 Iniciando PostgreSQL replica..."
exec postgres

