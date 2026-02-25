#!/bin/bash
set -e

echo "🚀 Iniciando deploy do backend..."

# Cores para output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Verifica se está em um repositório git e se deve fazer pull
if [ -z "$SKIP_GIT_PULL" ] && [ -d .git ]; then
    echo -e "${BLUE}📥 Fazendo pull do código...${NC}"
    git pull || echo -e "${YELLOW}⚠️  Aviso: Falha ao fazer pull (continuando mesmo assim)${NC}"
elif [ -n "$SKIP_GIT_PULL" ]; then
    echo -e "${BLUE}📥 Pull já foi executado, pulando...${NC}"
elif [ ! -d .git ]; then
    echo -e "${YELLOW}⚠️  Não é um repositório git, pulando pull${NC}"
fi

# Verifica se o .env existe
if [ ! -f .env ]; then
    echo -e "${RED}❌ Arquivo .env não encontrado!${NC}"
    exit 1
fi

echo -e "${BLUE}🔨 Construindo imagem Docker...${NC}"
docker compose build backend

echo -e "${BLUE}🐘 Subindo PostgreSQL e Redis...${NC}"
docker compose up -d postgres redis

echo -e "${YELLOW}⏳ Aguardando PostgreSQL estar pronto...${NC}"
MAX_WAIT=30
WAITED=0
until docker compose exec -T postgres pg_isready -U ${POSTGRES_USER:-podiogo} > /dev/null 2>&1; do
    if [ $WAITED -ge $MAX_WAIT ]; then
        echo -e "${RED}❌ Timeout aguardando PostgreSQL${NC}"
        exit 1
    fi
    echo "Aguardando PostgreSQL... ($WAITED/$MAX_WAIT segundos)"
    sleep 2
    WAITED=$((WAITED + 2))
done

echo -e "${GREEN}✅ PostgreSQL está pronto!${NC}"

echo -e "${BLUE}🚀 Subindo backend...${NC}"
docker compose up -d backend

echo -e "${YELLOW}⏳ Aguardando backend estar pronto...${NC}"
sleep 5

echo -e "${BLUE}🔄 Executando migrações do banco de dados...${NC}"
docker compose exec backend pnpm prisma migrate deploy || {
    echo -e "${RED}❌ Erro ao executar migrações${NC}"
    echo -e "${YELLOW}Verificando logs do backend...${NC}"
    docker compose logs --tail=50 backend
    exit 1
}

echo -e "${GREEN}✅ Migrações executadas com sucesso!${NC}"

echo -e "${BLUE}🔄 Reiniciando backend para aplicar mudanças...${NC}"
docker compose restart backend

echo -e "${GREEN}✅ Deploy concluído com sucesso!${NC}"
echo ""
echo -e "${BLUE}📊 Status dos containers:${NC}"
docker compose ps

echo ""
echo -e "${BLUE}📋 Logs recentes do backend:${NC}"
docker compose logs --tail=20 backend
