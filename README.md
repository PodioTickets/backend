# PodioTickets API

API backend para o sistema de gestão de eventos e vendas de ingressos PodioTickets.

## Documentação

### Suspender / reativar evento (organizador)

[Documentação: suspender, reativar e fluxo de status](./docs/EVENT_SUSPEND_ORGANIZER_API.md)

### Membros da organização (owner)

[Documentação: adicionar, listar, papel e remoção de membros](./docs/ORGANIZATION_MEMBERS_API.md) · [Referência HTTP: payloads e `data`](./docs/ORGANIZATIONS_HTTP_REFERENCE.md) · [Audit do organizador — integração frontend](./docs/ORGANIZER_AUDIT_FRONTEND.md) · [Notificações do evento (API) — Central de Comunicação](./EVENT_NOTIFICATIONS_API.md)

### API de Pagamento

Para informações detalhadas sobre como processar pagamentos, consulte a [Documentação da API de Pagamento](./docs/PAYMENT_API.md).

A documentação inclui:
- Endpoints e autenticação
- Métodos de pagamento (PIX, Cartão de Crédito, Boleto)
- Estrutura de requisições e respostas
- Exemplos práticos
- Tratamento de erros

## Tecnologias

- NestJS
- Prisma ORM
- PostgreSQL
- Cielo API (Gateway de Pagamento)

## Instalação

```bash
npm install
```

## Configuração

Configure as variáveis de ambiente no arquivo `.env`:

```env
DATABASE_URL="postgresql://..."
CIELO_MERCHANT_ID="..."
CIELO_MERCHANT_KEY="..."
JWT_SECRET="..."
```

## Execução

```bash
# Desenvolvimento
npm run start:dev

# Produção
npm run build
npm run start:prod
```

## Migrations

```bash
# Criar migration
npx prisma migrate dev

# Aplicar migrations em produção
npx prisma migrate deploy
```

## Documentação Swagger

Acesse a documentação interativa da API em:
```
http://localhost:3333/api
```
