.PHONY: help up down build restart logs ps shell migrate studio test clean

help: ## Mostra esta ajuda
	@echo "Comandos disponíveis:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

up: ## Inicia todos os serviços
	docker-compose up -d

down: ## Para todos os serviços
	docker-compose down

build: ## Build das imagens
	docker-compose build

rebuild: ## Rebuild forçado (sem cache)
	docker-compose build --no-cache

restart: ## Reinicia todos os serviços
	docker-compose restart

logs: ## Mostra logs de todos os serviços
	docker-compose logs -f

logs-app: ## Mostra logs da aplicação
	docker-compose logs -f backend

logs-db: ## Mostra logs do PostgreSQL
	docker-compose logs -f postgres

logs-redis: ## Mostra logs do Redis
	docker-compose logs -f redis

ps: ## Mostra status dos serviços
	docker-compose ps

shell: ## Abre shell no container da aplicação
	docker-compose exec backend sh

shell-db: ## Abre shell no PostgreSQL
	docker-compose exec postgres psql -U podiogo -d podiogo

shell-redis: ## Abre shell no Redis
	docker-compose exec redis redis-cli -a podiogo123

migrate: ## Executa migrações do banco
	docker-compose exec backend pnpm db:migrate deploy

migrate-dev: ## Executa migrações em modo dev
	docker-compose exec backend pnpm db:migrate

push: ## Faz push do schema Prisma
	docker-compose exec backend pnpm db:push

generate: ## Gera Prisma Client
	docker-compose exec backend pnpm db:generate

studio: ## Abre Prisma Studio
	docker-compose exec backend pnpm db:studio

test: ## Executa testes
	docker-compose exec backend pnpm test

clean: ## Remove containers e volumes (CUIDADO: apaga dados!)
	docker-compose down -v

clean-all: ## Remove tudo incluindo imagens
	docker-compose down -v --rmi all

health: ## Testa health check
	curl http://localhost/health

stats: ## Mostra estatísticas de uso de recursos
	docker stats

stop: ## Para todos os serviços
	docker-compose stop

start: ## Inicia serviços parados
	docker-compose start

