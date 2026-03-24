# Guia de Deploy na VPS

## Pré-requisitos na VPS

### Droplet com 1 GB de RAM (build Docker na própria VPS)

Se `docker compose build backend` termina com **`failed to execute bake: signal: killed`** no passo `nest build` / `prisma generate`, em geral é **falta de memória (OOM)** — o kernel mata o processo.

Neste projeto o build do container usa por padrão heap menor (`NODE_MAX_OLD_SPACE_SIZE`, ver `docker-compose.yml`). Ainda assim, em **1 GB** recomenda-se:

1. **Swap** de 1–2 GB (ex.: DigitalOcean: [How to add swap](https://www.digitalocean.com/community/tutorials/how-to-add-swap-space-on-ubuntu-22-04)).
2. Opcional no `.env`: `NODE_MAX_OLD_SPACE_SIZE=1024` (só se tiver swap ou mais RAM; senão pode voltar a dar OOM).

No `docker-compose.yml`, `REPLICA_PASSWORD` usa `${REPLICA_PASSWORD:-}` (vazio se não existir no `.env`), para não gerar aviso quando você não usa réplica.

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

# Database URL (usado pela aplicação DENTRO do Docker)
DATABASE_URL=postgresql://podiogo:<senha-forte-postgres>@postgres:5432/podiogo?schema=public&connection_limit=20&pool_timeout=20

# Database URL para migrações executadas FORA do Docker (use localhost)
# Descomente a linha abaixo quando for executar migrações manualmente na VPS:
# DATABASE_URL=postgresql://podiogo:<senha-forte-postgres>@localhost:5432/podiogo?schema=public

# Adicione outras variáveis necessárias (JWT_SECRET, API_KEYS, etc.)
JWT_SECRET=<seu-jwt-secret>

# Cielo Payment Gateway (obrigatório para processar pagamentos)
CIELO_MERCHANT_ID=<seu-merchant-id-da-cielo>
CIELO_MERCHANT_KEY=<sua-merchant-key-da-cielo>
CIELO_ENV=production  # Use "production" para produção ou deixe vazio/outro valor para sandbox
CIELO_WEBHOOK_SECRET=<seu-webhook-secret-da-cielo>  # Opcional, mas recomendado

# ... outras variáveis da sua aplicação
```

**Importante:** Use senhas fortes e únicas em produção!

#### Configuração da Cielo (Gateway de Pagamento)

Para processar pagamentos, você precisa configurar as credenciais da Cielo:

1. **Acesse o painel da Cielo**: https://cieloecommerce.cielo.com.br/
2. **Obtenha suas credenciais**:
   - `CIELO_MERCHANT_ID`: Seu Merchant ID (disponível no painel)
   - `CIELO_MERCHANT_KEY`: Sua Merchant Key (disponível no painel)
3. **Configure o ambiente**:
   - `CIELO_ENV=production` para usar a API de produção
   - Deixe vazio ou use outro valor para usar o ambiente sandbox (testes)
4. **Webhook Secret** (opcional mas recomendado):
   - `CIELO_WEBHOOK_SECRET`: Chave secreta para validar webhooks da Cielo

**⚠️ IMPORTANTE**: Sem essas variáveis configuradas, você receberá o erro "Cielo is not configured" ao tentar processar pagamentos.

### 4. Executar migrações do banco de dados

**IMPORTANTE:** Como o PostgreSQL está rodando dentro do Docker, você precisa executar as migrações de uma forma que consiga acessar o container.

**Opção A: Executar migrações DENTRO do container (RECOMENDADO)**

```bash
# 1. Subir apenas PostgreSQL primeiro
docker compose up -d postgres

# 2. Aguardar o banco estar pronto
sleep 10

# 3. Executar migrações dentro do container backend (mesmo que ainda não esteja rodando)
# Primeiro, precisamos ter o Prisma CLI disponível. Você pode:
# a) Instalar temporariamente no container, ou
# b) Usar um container temporário com Node.js

# Opção mais simples: usar um container temporário com Node.js
docker run --rm \
  -v $(pwd):/app \
  -w /app \
  --network podiogo_podiogo-network \
  -e DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public" \
  node:20-alpine sh -c "npm install -g pnpm && pnpm install && pnpm prisma migrate deploy"

# Depois subir o backend
docker compose up -d --build
```

**Opção B: Executar migrações FORA do container (requer configuração)**

Se você quiser executar migrações diretamente na VPS (fora do Docker), você precisa:

1. **Configurar a DATABASE_URL corretamente no `.env`** para apontar para o container:

```env
# Para acessar o PostgreSQL do container de fora, use o IP do container ou localhost
# Se o PostgreSQL está exposto na porta 5432 do host:
DATABASE_URL=postgresql://podiogo:<sua-senha>@localhost:5432/podiogo?schema=public

# OU use o IP do container (mais confiável)
# Primeiro descubra o IP: docker inspect podiogo-postgres | grep IPAddress
# DATABASE_URL=postgresql://podiogo:<sua-senha>@<ip-do-container>:5432/podiogo?schema=public
```

2. **Garantir que a porta 5432 está acessível** (o docker-compose.yml já expõe)

3. **Executar as migrações:**
```bash
cd /opt/podiogo/backend
pnpm install
pnpm prisma migrate deploy
```

**⚠️ ATENÇÃO:** A Opção B requer que você tenha as mesmas credenciais no `.env` que foram usadas para criar o container PostgreSQL. Se você mudou `POSTGRES_USER` ou `POSTGRES_PASSWORD` depois de criar o container, você precisa recriar o volume do banco ou ajustar as credenciais.

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

# Persistência de imagens (uploads): o backend usa o volume uploads_data para
# guardar banner/logo dos eventos, avatares e PDFs. Sem esse volume, a cada
# deploy/restart as imagens somem. Com o volume, elas permanecem entre deploys.

# Rebuild da imagem
docker compose build --no-cache backend
docker compose up -d backend

# Executar comandos dentro do container
docker compose exec backend sh

# Executar script de popular dados de simulação
# Opção 1: Com evento específico (por ID ou slug)
docker compose exec backend pnpm db:populate-simulation <eventId-ou-slug>

# Opção 2: Sem argumento (usa o primeiro evento disponível)
docker compose exec backend pnpm db:populate-simulation

# Exemplo:
docker compose exec backend pnpm db:populate-simulation 936b39f0-c774-4f01-95fe-4da4a962bd8f
docker compose exec backend pnpm db:populate-simulation ee7fe954-1c21-470b-979c-5dbf82406edc

# Se o comando acima não funcionar, tente:
docker compose exec backend npx ts-node --project tsconfig.node.json prisma/populate-simulation-data.ts 936b39f0-c774-4f01-95fe-4da4a962bd8f

# Ou use node diretamente (compilando primeiro):
docker compose exec backend sh -c "npx tsc prisma/populate-simulation-data.ts --outDir /tmp --module commonjs --target es2017 --esModuleInterop && node /tmp/populate-simulation-data.js 936b39f0-c774-4f01-95fe-4da4a962bd8f"

# Ver uso de recursos
docker stats

# Backup do banco de dados
docker compose exec postgres pg_dump -U podiogo podiogo > backup_$(date +%Y%m%d_%H%M%S).sql

# Restaurar backup
docker compose exec -T postgres psql -U podiogo podiogo < backup.sql
```

### Correção: accountType ORGANIZER (login organizador)

Se organizadores existentes não conseguem fazer login em `POST /api/v1/auth/login/organizer` (o check `GET /api/v1/organizations/me/check` funciona porque usa só JWT), é porque o usuário está com `accountType = 'USER'`. Execute **uma vez** na VPS, no diretório do backend:

```bash
cd /opt/podiogo/backend   # ou o caminho onde está o projeto

# Usando o script (substitua podiogo pelo seu POSTGRES_USER se for diferente)
docker compose exec -T postgres psql -U podiogo -d podiogo < scripts/fix-organizer-account-type.sql
```

Ou em uma linha, sem script:

```bash
docker compose exec postgres psql -U podiogo -d podiogo -c "UPDATE \"User\" SET \"accountType\" = 'ORGANIZER' WHERE id IN (SELECT \"userId\" FROM \"OrganizationMember\" WHERE role = 'OWNER') AND \"accountType\" = 'USER';"
```

Troque `podiogo` por `$POSTGRES_USER` (ou o valor do seu `.env`) se for diferente.

## Deploy Automático via GitHub Actions

O projeto está configurado para fazer deploy automático sempre que você fizer push para a branch `master` ou `main` no GitHub.

### Configuração Inicial

1. **Configurar Secrets no GitHub:**
   - Vá em: `Settings` → `Secrets and variables` → `Actions`
   - Adicione os seguintes secrets:
     - `SERVER_IP`: IP do seu servidor VPS
     - `SERVER_USER`: Usuário SSH (ex: `root` ou `ubuntu`)
     - `SSH_PRIVATE_KEY`: Chave privada SSH para acessar o servidor

2. **Gerar chave SSH (se ainda não tiver):**
   ```bash
   # No seu computador local
   ssh-keygen -t ed25519 -C "github-actions-deploy"
   
   # Copiar a chave pública para o servidor
   ssh-copy-id -i ~/.ssh/id_ed25519.pub usuario@seu-servidor-ip
   
   # Copiar a chave privada para adicionar no GitHub Secrets
   cat ~/.ssh/id_ed25519
   ```

3. **Configurar o repositório Git no servidor:**
   ```bash
   # Na VPS
   cd /opt/podiogo/backend
   
   # Se ainda não tiver o repositório clonado:
   git clone <seu-repositorio-github> /opt/podiogo/backend
   
   # Ou se já tiver, configurar o remote:
   git remote set-url origin <seu-repositorio-github>
   git checkout master  # ou main, dependendo da sua branch padrão
   ```

### Como Funciona

Quando você fizer `git push` para a branch `master` ou `main`:

1. ✅ O GitHub Actions detecta o push
2. ✅ Conecta via SSH no servidor
3. ✅ Faz `git pull` para atualizar o código
4. ✅ Verifica se o PostgreSQL está rodando
5. ✅ Executa migrações do banco de dados automaticamente
6. ✅ Faz rebuild da imagem Docker
7. ✅ Reinicia o container do backend
8. ✅ Verifica a saúde do container

### Verificar Deploy

Após fazer push, você pode:

1. **Ver o progresso no GitHub:**
   - Vá em `Actions` no seu repositório
   - Clique no workflow em execução para ver os logs

#### Timeout no GitHub Actions (“job failed” / SSH cortando no meio do `docker build`)

O `appleboy/ssh-action` tem dois limites importantes:

- **`command_timeout`**: tempo máximo para o script remoto (antes o padrão da action era **10 minutos** — um `docker compose build` com `pnpm install` + Prisma + Nest na VPS costuma passar disso).
- **`timeout-minutes` do job**: tempo máximo do workflow inteiro no GitHub.

No repositório, `.github/workflows/deploy.yml` já aumenta esses valores e o `Dockerfile` usa **cache do store do pnpm** (BuildKit) para acelerar rebuilds na VPS.

Se ainda estourar tempo, opções:

- Aumentar `command_timeout` / `timeout-minutes` no workflow.
- VPS com mais CPU/RAM ou disco mais rápido (build em disco lento demora muito).
- **Deploy avançado**: build da imagem no GitHub Actions, push para um registry (GHCR) e na VPS só `docker compose pull && up` (elimina compilação pesada no servidor).

2. **Verificar no servidor:**
   ```bash
   # Ver logs do último deploy
   docker compose logs --tail=50 backend
   
   # Ver status dos containers
   docker compose ps
   ```

### Deploy Manual (Alternativa)

Se preferir fazer deploy manualmente ou se o GitHub Actions falhar:

**Opção A: Usando o script deploy.sh**
```bash
cd /opt/podiogo/backend
./deploy.sh update
```

**Opção B: Manualmente**
```bash
cd /opt/podiogo/backend

# 1. Atualizar código
git pull

# 2. Executar migrações
./deploy.sh migrate

# 3. Rebuild e restart
docker compose build --no-cache backend
docker compose up -d backend

# 4. Verificar logs
docker compose logs -f backend
```

## Atualizações Futuras (Manual)

Se você não estiver usando o deploy automático, siga estes passos:

```bash
# 1. Fazer pull das mudanças
cd /srv/backend
git pull

# 2. Executar novas migrações (se houver)
./deploy.sh migrate

# 3. Rebuild e restart
docker compose build backend
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

### `docker compose build backend` demora muito ou parece travar (VPS pequena)

Em droplets **1 vCPU / 1 GB RAM**, o compilador TypeScript (`tsc`) dentro do build do Docker pode levar **vários minutos** ou ficar em **swap** (parece “não carregar nunca”). Este repositório usa **`pnpm run build:docker`** no Dockerfile (**Nest + SWC**), que é bem mais leve e rápido que o `nest build` padrão.

Se ainda assim ficar lento ou o processo for morto (`signal: killed`):

1. **Adicionar swap** (2 GB é um bom começo):
   ```bash
   sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
   sudo mkswap /swapfile && sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   free -h
   ```

2. **BuildKit** (cache de camadas):
   ```bash
   export DOCKER_BUILDKIT=1
   docker compose build backend
   ```

3. **Limite de heap do Node no build** (no `.env` na pasta do compose, opcional):
   ```env
   NODE_MAX_OLD_SPACE_SIZE=768
   ```
   Valores muito altos em máquina com 1 GB de RAM podem piorar (disputa com o Docker).

4. **Alternativa**: fazer o build da imagem em uma máquina com mais RAM (CI/GitHub Actions, notebook) e publicar no registry (`docker push`), e na VPS só `docker compose pull && up -d`.

**Nota:** `pnpm build` local/CI continua usando **tsc** (checagem de tipos completa). O alvo `build:docker` é otimizado para imagem de produção.

## Segurança Adicional

1. **Não exponha portas do banco e Redis publicamente**
2. **Use senhas fortes** em todas as variáveis de ambiente
3. **Mantenha o Docker atualizado**: `sudo apt update && sudo apt upgrade docker.io`
4. **Configure fail2ban** para proteger contra ataques de força bruta
5. **Use secrets do Docker** para informações sensíveis (em vez de .env em alguns casos)

