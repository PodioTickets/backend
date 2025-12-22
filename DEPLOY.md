# Guia de Deploy na VPS

## Pré-requisitos na VPS

1. **Docker e Docker Compose instalados**
```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh
sudo usermod -aG docker $USER

# Instalar Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

2. **Node.js e pnpm (para executar migrações manualmente)**
```bash
# Node.js via nvm (recomendado)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# Instalar pnpm
npm install -g pnpm
```

## Passo a Passo do Deploy

### 1. Preparar o ambiente na VPS

```bash
# Criar diretório do projeto
mkdir -p /opt/podiogo/backend
cd /opt/podiogo/backend
```

### 2. Transferir arquivos para a VPS

**Opção A: Via Git (recomendado)**
```bash
# Na VPS
git clone <seu-repositorio> /opt/podiogo/backend
cd /opt/podiogo/backend
```

**Opção B: Via SCP**
```bash
# No seu computador local
scp -r . usuario@vps-ip:/opt/podiogo/backend/
```

### 3. Configurar variáveis de ambiente

```bash
# Na VPS
cd /opt/podiogo/backend
nano .env
```

Crie o arquivo `.env` com as seguintes variáveis:

```env
# Database
POSTGRES_USER=podiogo
POSTGRES_PASSWORD=<senha-forte-postgres>
POSTGRES_DB=podiogo
REPLICA_PASSWORD=<senha-replica-se-usar>

# Redis
REDIS_PASSWORD=<senha-forte-redis>

# Aplicação
NODE_ENV=production
PORT=3333

# Database URL (usado pela aplicação)
DATABASE_URL=postgresql://podiogo:<senha-forte-postgres>@postgres:5432/podiogo?schema=public&connection_limit=20&pool_timeout=20

# Adicione outras variáveis necessárias (JWT_SECRET, API_KEYS, etc.)
JWT_SECRET=<seu-jwt-secret>
# ... outras variáveis da sua aplicação
```

**Importante:** Use senhas fortes e únicas em produção!

### 4. Executar migrações do banco de dados

**Antes de subir os containers**, você precisa ter o banco rodando. Você tem duas opções:

**Opção A: Subir apenas PostgreSQL primeiro**
```bash
# Criar um docker-compose temporário só com PostgreSQL
docker compose up -d postgres

# Aguardar o banco estar pronto
sleep 10

# Executar migrações localmente na VPS (com Node.js instalado)
pnpm install
pnpm prisma migrate deploy
# ou
pnpm prisma db push

# Depois subir tudo
docker compose up -d
```

**Opção B: Subir tudo e executar migrações depois**
```bash
# Subir todos os containers
docker compose up -d

# Aguardar o banco estar pronto
sleep 10

# Executar migrações (com Node.js instalado na VPS)
cd /opt/podiogo/backend
pnpm install
pnpm prisma migrate deploy
```

### 5. Build e subir os containers

```bash
cd /opt/podiogo/backend

# Build da imagem e subir todos os serviços
docker compose up -d --build

# Verificar se está tudo rodando
docker compose ps
docker compose logs -f backend
```

### 6. Verificar se está funcionando

```bash
# Ver logs do backend
docker compose logs -f backend

# Verificar saúde dos containers
docker compose ps

# Testar endpoint de health (se tiver)
curl http://localhost:3333/health
```

### 7. Configurar Nginx como Reverse Proxy (Recomendado)

```bash
# Instalar Nginx
sudo apt update
sudo apt install nginx

# Criar configuração
sudo nano /etc/nginx/sites-available/podiogo
```

Conteúdo do arquivo `/etc/nginx/sites-available/podiogo`:

```nginx
server {
    listen 80;
    server_name seu-dominio.com;

    location / {
        proxy_pass http://localhost:3333;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Ativar site
sudo ln -s /etc/nginx/sites-available/podiogo /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 8. Configurar SSL com Let's Encrypt (Recomendado)

```bash
# Instalar Certbot
sudo apt install certbot python3-certbot-nginx

# Obter certificado SSL
sudo certbot --nginx -d seu-dominio.com

# Renovação automática (já configurada por padrão)
sudo certbot renew --dry-run
```

### 9. Configurar Firewall

```bash
# UFW (Ubuntu)
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp     # HTTP
sudo ufw allow 443/tcp    # HTTPS
sudo ufw enable

# Não exponha as portas 5432 (PostgreSQL) e 6379 (Redis) publicamente!
# Elas só devem ser acessíveis dentro da rede Docker
```

### 10. Configurar restart automático dos containers

O `docker-compose.yml` já tem `restart: unless-stopped`, mas você pode garantir que o Docker inicie na inicialização do sistema:

```bash
sudo systemctl enable docker
```

## Comandos Úteis para Manutenção

```bash
# Ver logs
docker compose logs -f backend
docker compose logs -f postgres
docker compose logs -f redis

# Reiniciar serviços
docker compose restart backend
docker compose restart

# Parar tudo
docker compose down

# Parar e remover volumes (CUIDADO: apaga dados!)
docker compose down -v

# Rebuild da imagem
docker compose build --no-cache backend
docker compose up -d backend

# Executar comandos dentro do container
docker compose exec backend sh

# Ver uso de recursos
docker stats

# Backup do banco de dados
docker compose exec postgres pg_dump -U podiogo podiogo > backup_$(date +%Y%m%d_%H%M%S).sql

# Restaurar backup
docker compose exec -T postgres psql -U podiogo podiogo < backup.sql
```

## Atualizações Futuras

```bash
# 1. Fazer pull das mudanças
cd /opt/podiogo/backend
git pull

# 2. Executar novas migrações (se houver)
pnpm prisma migrate deploy

# 3. Rebuild e restart
docker compose build --no-cache backend
docker compose up -d backend

# 4. Verificar logs
docker compose logs -f backend
```

## Monitoramento (Opcional)

Considere adicionar:
- **PM2** ou **systemd** para monitorar o container
- **Sentry** para tracking de erros (já parece estar configurado)
- **Logs centralizados** (ELK, Loki, etc.)
- **Métricas** (Prometheus + Grafana)

## Troubleshooting

### Container não inicia
```bash
docker compose logs backend
docker compose ps
```

### Banco de dados não conecta
```bash
# Verificar se o PostgreSQL está rodando
docker compose ps postgres
docker compose logs postgres

# Testar conexão
docker compose exec postgres psql -U podiogo -d podiogo
```

### Porta já em uso
```bash
# Verificar o que está usando a porta
sudo lsof -i :3333
sudo netstat -tulpn | grep 3333
```

### Problemas de permissão
```bash
# Verificar permissões dos volumes
docker compose exec backend ls -la /usr/src/app/uploads
```

## Segurança Adicional

1. **Não exponha portas do banco e Redis publicamente**
2. **Use senhas fortes** em todas as variáveis de ambiente
3. **Mantenha o Docker atualizado**: `sudo apt update && sudo apt upgrade docker.io`
4. **Configure fail2ban** para proteger contra ataques de força bruta
5. **Use secrets do Docker** para informações sensíveis (em vez de .env em alguns casos)

