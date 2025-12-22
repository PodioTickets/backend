#!/bin/bash

# Script de deploy para VPS
# Uso: ./deploy.sh [comando]
# Comandos: setup, up, down, restart, logs, migrate, backup

set -e

PROJECT_DIR="/opt/podiogo/backend"
COMPOSE_FILE="docker-compose.yml"

cd "$PROJECT_DIR" || exit 1

case "$1" in
  setup)
    echo "🚀 Configurando ambiente de produção..."
    
    # Verificar se .env existe
    if [ ! -f .env ]; then
      echo "❌ Arquivo .env não encontrado!"
      echo "📝 Crie o arquivo .env com as variáveis necessárias"
      exit 1
    fi
    
    # Verificar se Docker está instalado
    if ! command -v docker &> /dev/null; then
      echo "❌ Docker não está instalado!"
      exit 1
    fi
    
    # Verificar se Docker Compose está instalado
    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
      echo "❌ Docker Compose não está instalado!"
      exit 1
    fi
    
    echo "✅ Ambiente verificado"
    ;;
    
  up)
    echo "🚀 Subindo containers..."
    docker compose -f "$COMPOSE_FILE" up -d --build
    echo "✅ Containers iniciados"
    echo "📊 Status:"
    docker compose -f "$COMPOSE_FILE" ps
    ;;
    
  down)
    echo "🛑 Parando containers..."
    docker compose -f "$COMPOSE_FILE" down
    echo "✅ Containers parados"
    ;;
    
  restart)
    echo "🔄 Reiniciando containers..."
    docker compose -f "$COMPOSE_FILE" restart
    echo "✅ Containers reiniciados"
    ;;
    
  logs)
    SERVICE="${2:-backend}"
    echo "📋 Logs do serviço: $SERVICE"
    docker compose -f "$COMPOSE_FILE" logs -f "$SERVICE"
    ;;
    
  migrate)
    echo "🗄️  Executando migrações..."
    
    # Verificar se o banco está rodando
    if ! docker compose -f "$COMPOSE_FILE" ps postgres | grep -q "Up"; then
      echo "⚠️  PostgreSQL não está rodando. Iniciando..."
      docker compose -f "$COMPOSE_FILE" up -d postgres
      echo "⏳ Aguardando PostgreSQL estar pronto..."
      sleep 10
    fi
    
    # Carregar variáveis do .env
    if [ -f .env ]; then
      export $(grep -v '^#' .env | xargs)
    else
      echo "❌ Arquivo .env não encontrado!"
      exit 1
    fi
    
    # Construir DATABASE_URL se não estiver definida
    if [ -z "$DATABASE_URL" ]; then
      DATABASE_URL="postgresql://${POSTGRES_USER:-podiogo}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-podiogo}?schema=public"
    fi
    
    # Obter nome da rede Docker
    NETWORK_NAME=$(docker compose -f "$COMPOSE_FILE" config | grep -A 5 "networks:" | grep -v "networks:" | head -1 | awk '{print $1}' | tr -d ':')
    if [ -z "$NETWORK_NAME" ]; then
      # Tentar obter do nome do projeto
      PROJECT_NAME=$(basename $(pwd))
      NETWORK_NAME="${PROJECT_NAME}_podiogo-network"
    fi
    
    echo "🌐 Usando rede: $NETWORK_NAME"
    echo "🔗 DATABASE_URL: postgresql://${POSTGRES_USER:-podiogo}:***@postgres:5432/${POSTGRES_DB:-podiogo}"
    
    # Executar migrações usando container temporário
    echo "🔄 Aplicando migrações..."
    docker run --rm \
      -v "$(pwd):/app" \
      -w /app \
      --network "$NETWORK_NAME" \
      -e DATABASE_URL="$DATABASE_URL" \
      node:20-alpine sh -c "
        npm install -g pnpm && \
        pnpm install && \
        pnpm prisma migrate deploy
      "
    
    if [ $? -eq 0 ]; then
      echo "✅ Migrações aplicadas com sucesso"
    else
      echo "❌ Erro ao aplicar migrações"
      exit 1
    fi
    ;;
    
  backup)
    BACKUP_DIR="./backups"
    BACKUP_FILE="backup_$(date +%Y%m%d_%H%M%S).sql"
    
    echo "💾 Criando backup do banco de dados..."
    mkdir -p "$BACKUP_DIR"
    
    docker compose -f "$COMPOSE_FILE" exec -T postgres pg_dump -U "${POSTGRES_USER:-podiogo}" "${POSTGRES_DB:-podiogo}" > "$BACKUP_DIR/$BACKUP_FILE"
    
    if [ $? -eq 0 ]; then
      echo "✅ Backup criado: $BACKUP_DIR/$BACKUP_FILE"
      # Comprimir backup
      gzip "$BACKUP_DIR/$BACKUP_FILE"
      echo "📦 Backup comprimido: $BACKUP_DIR/$BACKUP_FILE.gz"
    else
      echo "❌ Erro ao criar backup"
      exit 1
    fi
    ;;
    
  ps)
    echo "📊 Status dos containers:"
    docker compose -f "$COMPOSE_FILE" ps
    ;;
    
  shell)
    SERVICE="${2:-backend}"
    echo "🐚 Abrindo shell no container: $SERVICE"
    docker compose -f "$COMPOSE_FILE" exec "$SERVICE" sh
    ;;
    
  update)
    echo "🔄 Atualizando aplicação..."
    
    # Fazer backup antes de atualizar
    echo "💾 Criando backup..."
    $0 backup
    
    # Pull do código (se usar git)
    if [ -d .git ]; then
      echo "📥 Atualizando código..."
      git pull
    fi
    
    # Rebuild e restart
    echo "🔨 Rebuild da imagem..."
    docker compose -f "$COMPOSE_FILE" build --no-cache backend
    
    echo "🔄 Reiniciando containers..."
    docker compose -f "$COMPOSE_FILE" up -d backend
    
    echo "✅ Atualização concluída"
    echo "📋 Logs:"
    docker compose -f "$COMPOSE_FILE" logs --tail=50 backend
    ;;
    
  *)
    echo "Uso: $0 [comando]"
    echo ""
    echo "Comandos disponíveis:"
    echo "  setup     - Verificar e configurar ambiente"
    echo "  up        - Subir todos os containers"
    echo "  down      - Parar todos os containers"
    echo "  restart   - Reiniciar containers"
    echo "  logs      - Ver logs (opcional: especificar serviço)"
    echo "  migrate   - Executar migrações do banco"
    echo "  backup    - Criar backup do banco de dados"
    echo "  ps        - Ver status dos containers"
    echo "  shell     - Abrir shell no container (opcional: especificar serviço)"
    echo "  update    - Atualizar aplicação (backup + rebuild + restart)"
    echo ""
    echo "Exemplos:"
    echo "  $0 up"
    echo "  $0 logs backend"
    echo "  $0 shell postgres"
    exit 1
    ;;
esac

