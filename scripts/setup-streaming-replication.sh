#!/bin/bash
# Script para configurar streaming replication manualmente em containers existentes

echo "🔄 Configurando Streaming Replication Manualmente..."

# 1. Verificar se o usuário de replicação existe no master
echo "1️⃣ Verificando usuário de replicação no master..."
docker exec podiogo-postgres psql -U podiogo -d podiogo -c "
DO \$\$ 
BEGIN 
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_user WHERE usename = 'replicator') THEN 
    CREATE USER replicator REPLICATION LOGIN PASSWORD 'replicator123'; 
    RAISE NOTICE 'Usuário replicator criado';
  ELSE
    RAISE NOTICE 'Usuário replicator já existe';
  END IF; 
END \$\$;
"

# 2. Criar slot de replicação se não existir
echo "2️⃣ Verificando slot de replicação..."
docker exec podiogo-postgres psql -U podiogo -d podiogo -c "
SELECT pg_create_physical_replication_slot('replica_slot', true);
" 2>&1 | grep -v "already exists" || echo "Slot já existe"

# 3. Parar o replica
echo "3️⃣ Parando replica..."
docker-compose -f docker-compose.dev.yml stop postgres-replica

# 4. Remover dados antigos do replica
echo "4️⃣ Removendo dados antigos do replica..."
docker volume rm podiogo_postgres_replica_data 2>/dev/null || echo "Volume não existe ou já foi removido"

# 5. Criar novo volume
echo "5️⃣ Criando novo volume..."
docker volume create podiogo_postgres_replica_data

# 6. Configurar pg_hba.conf no master para permitir replicação
echo "6️⃣ Configurando pg_hba.conf no master..."
docker exec podiogo-postgres sh -c 'echo "host replication replicator 0.0.0.0/0 md5" >> /var/lib/postgresql/data/pgdata/pg_hba.conf'
docker exec podiogo-postgres psql -U podiogo -d podiogo -c "SELECT pg_reload_conf();"

# 7. Fazer backup base do master para o replica
echo "7️⃣ Fazendo backup base do master..."
docker run --rm \
  -v podiogo_postgres_replica_data:/backup \
  --network podiogo_podiogo-network \
  postgres:16-alpine \
  pg_basebackup \
  -h podiogo-postgres \
  -p 5432 \
  -U replicator \
  -D /backup/pgdata \
  -Fp \
  -Xs \
  -P \
  -R \
  -S replica_slot \
  -W <<EOF
replicator123
EOF

# 8. Configurar arquivos de recovery no replica
echo "8️⃣ Configurando arquivos de recovery..."
docker run --rm \
  -v podiogo_postgres_replica_data:/data \
  postgres:16-alpine \
  sh -c "
    echo 'primary_conninfo = '\''host=podiogo-postgres port=5432 user=replicator password=replicator123'\''' > /data/pgdata/postgresql.auto.conf
    echo 'primary_slot_name = replica_slot' >> /data/pgdata/postgresql.auto.conf
    touch /data/pgdata/standby.signal
    echo 'hot_standby = on' >> /data/pgdata/postgresql.conf
    echo 'max_standby_streaming_delay = 30s' >> /data/pgdata/postgresql.conf
    echo 'wal_receiver_timeout = 60s' >> /data/pgdata/postgresql.conf
    echo 'hot_standby_feedback = on' >> /data/pgdata/postgresql.conf
  "

# 9. Iniciar o replica
echo "9️⃣ Iniciando replica..."
docker-compose -f docker-compose.dev.yml up -d postgres-replica

# 10. Aguardar inicialização
echo "⏳ Aguardando replica inicializar (10 segundos)..."
sleep 10

# 11. Verificar status
echo "🔍 Verificando status do replica..."
docker exec podiogo-postgres-replica psql -U podiogo -d podiogo -c "SELECT pg_is_in_recovery();"

echo ""
echo "✅ Configuração concluída!"
echo "📝 Execute 'pnpm db:test:replication' para testar"

