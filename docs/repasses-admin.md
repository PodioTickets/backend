# Repasses — Documentação para o Admin Frontend

## Visão Geral

Repasse é o processo de transferência do dinheiro arrecadado em um evento para o organizador. O fluxo envolve:

1. Comprador paga → dinheiro fica retido por um prazo (anti-fraude)
2. Prazo vencido → valor liberado, mas **10% retido** até auditoria
3. Organizador solicita saque → repasse fica `PENDING`
4. Admin aprova (→ `COMPLETED`) ou nega (→ `CANCELLED`)
5. Após o evento, admin realiza auditoria → 10% retido liberado para saque

---

## Modelo de Dados

### `EventWithdrawal` (Repasse/Saque)

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | UUID | Identificador único |
| `eventId` | UUID | Evento vinculado |
| `requestedById` | UUID | Usuário que solicitou |
| `amount` | int (centavos) | Valor bruto solicitado |
| `feeRate` | float | Taxa Podio no momento da solicitação (ex: `0.04` = 4%) |
| `feeAmount` | int (centavos) | Valor da taxa descontada |
| `netAmount` | int (centavos) | Valor líquido transferido ao organizador (`amount - feeAmount`) |
| `status` | enum | `PENDING` · `COMPLETED` · `CANCELLED` |
| `notes` | string? | Observação interna |
| `completedAt` | DateTime? | Quando foi concluído |
| `createdAt` | DateTime | Data da solicitação |

### `EventAudit` (Auditoria)

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | UUID | Identificador único |
| `eventId` | UUID | Único por evento (1 auditoria por evento) |
| `auditedById` | UUID | Admin que realizou a auditoria |
| `retentionReleased` | int (centavos) | Valor dos 10% liberados |
| `notes` | string? | Observação |
| `createdAt` | DateTime | Data da auditoria |

### Campos financeiros do `Event`

| Campo | Padrão | Descrição |
|---|---|---|
| `organizerFeeRate` | `0.04` | Taxa cobrada pela Podio sobre cada saque (4%) |
| `retentionRate` | `0.10` | Percentual retido até auditoria (10%) |

---

## Status Flow do Repasse

```
Organizer solicita saque
         │
         ▼
      PENDING  ◄── único status editável pelo admin
       /    \
      ▼      ▼
COMPLETED  CANCELLED
```

- **`PENDING`** — aguardando processamento pelo admin. O valor já foi debitado do `availableBalance` do organizador.
- **`COMPLETED`** — transferência realizada. `completedAt` é preenchido.
- **`CANCELLED`** — negado. O valor retorna automaticamente ao `availableBalance`.

> Apenas repasses `PENDING` podem ser aprovados ou negados.

---

## Fluxo Financeiro

### Prazos de liberação por método de pagamento

| Método | Prazo |
|---|---|
| PIX | 1 dia |
| Cartão de crédito (à vista) | 30 dias |
| Boleto | 3 dias |
| Crypto | 30 dias |

### Cálculo do saldo disponível

```
Receita Bruta
  = Soma de finalAmount de todos os pedidos pagos

Aguardando Liberação (pendingRelease)
  = Pedidos dentro do prazo de retenção (ainda não venceu)

Aguardando Auditoria (awaitingAudit)
  = 10% de cada pedido já liberado (pré-auditoria)
  OU última parcela do parcelado (pré-auditoria)

A Receber — Parcelas Futuras (installmentsToReceive)
  = Parcelas de cartão parcelado ainda não vencidas

Liberado e Disponível (releasedAndAvailable)
  = Pedidos liberados - retenção de 10%
  (Se auditado: 100% liberado, sem retenção)

Total Sacado (totalWithdrawn)
  = Soma dos saques COMPLETED

Saldo Disponível (availableBalance)
  = releasedAndAvailable - totalWithdrawn
```

### Pagamento parcelado

Cada parcela tem vencimento em intervalos de 30 dias a partir do pagamento:
- Parcelas 1 a N-1: liberadas após vencimento
- **Última parcela (N): retida até auditoria** (equivalente ao 10% de retenção)

### Após auditoria

- Os 10% retidos (`awaitingAudit`) passam imediatamente para `availableBalance`
- A auditoria é **irreversível** e **única por evento**
- `retentionReleased` no `EventAudit` registra o valor liberado

---

## Endpoints da API

Base: `GET|POST|PATCH /api/v1/events/:eventId/repasse/...`

Todos os endpoints exigem `Authorization: Bearer <token>`.

---

### `GET /summary`

Retorna o resumo financeiro completo do evento.

**Response:**
```json
{
  "data": {
    "summary": {
      "grossRevenue": 1500000,
      "pendingRelease": 200000,
      "awaitingAudit": 130000,
      "installmentsToReceive": 50000,
      "releasedAndAvailable": 970000,
      "totalWithdrawn": 300000,
      "availableBalance": 670000,
      "refundedOrders": 2,
      "isAudited": false,
      "auditedAt": null,
      "retentionReleased": 0,
      "organizerFeeRate": 0.04,
      "retentionRate": 0.10
    }
  }
}
```

> Todos os valores monetários estão em **centavos**.

---

### `GET /pending?page=1&limit=20`

Lista pedidos aguardando liberação do prazo ou aguardando auditoria.

**Response:**
```json
{
  "data": {
    "items": [
      {
        "orderId": "uuid",
        "paymentId": "uuid",
        "transactionId": "cielo-id",
        "type": "AWAITING_RELEASE",
        "amount": 15000,
        "retainedAmount": null,
        "paymentMethod": "PIX",
        "purchaseDate": "2025-04-20T14:00:00Z",
        "paymentDate": "2025-04-20T14:05:00Z",
        "releaseDate": "2025-04-21T14:05:00Z",
        "daysUntilRelease": 1,
        "buyer": { "id": "uuid", "firstName": "João", "lastName": "Silva", "email": "joao@email.com" }
      },
      {
        "orderId": "uuid",
        "type": "AWAITING_AUDIT",
        "amount": 10000,
        "retainedAmount": 1000,
        "paymentMethod": "CREDIT_CARD",
        "daysUntilRelease": 0,
        "buyer": { ... }
      }
    ],
    "totalRetained": 130000,
    "totalPendingRelease": 200000,
    "pagination": { "page": 1, "limit": 20, "total": 15, "totalPages": 1 }
  }
}
```

**Tipos de item:**
- `AWAITING_RELEASE` — dentro do prazo de retenção. `daysUntilRelease` > 0.
- `AWAITING_AUDIT` — prazo vencido mas 10% retido. `retainedAmount` = valor bloqueado.

---

### `GET /installments?page=1&limit=20`

Lista parcelas futuras de pagamentos parcelados.

**Response:**
```json
{
  "data": {
    "items": [
      {
        "id": "paymentId-installment-2",
        "orderId": "uuid",
        "paymentId": "uuid",
        "installmentNumber": 2,
        "totalInstallments": 6,
        "amount": 5000,
        "dueDate": "2025-05-20T14:00:00Z",
        "isLastInstallment": false,
        "retainedUntilAudit": false,
        "buyer": { ... }
      }
    ],
    "totalPending": 50000,
    "pagination": { ... }
  }
}
```

> `retainedUntilAudit: true` indica que essa parcela (a última) só será liberada após auditoria.

---

### `GET /withdrawals?page=1&limit=20`

Histórico de todos os saques do evento.

**Response:**
```json
{
  "data": {
    "withdrawals": [
      {
        "id": "uuid",
        "eventId": "uuid",
        "requestedById": "uuid",
        "amount": 50000,
        "feeRate": 0.04,
        "feeAmount": 2000,
        "netAmount": 48000,
        "status": "PENDING",
        "notes": null,
        "completedAt": null,
        "createdAt": "2025-04-22T10:00:00Z",
        "requestedBy": {
          "id": "uuid",
          "firstName": "Carlos",
          "lastName": "Souza",
          "email": "carlos@org.com"
        }
      }
    ],
    "totalNetWithdrawn": 144000,
    "pagination": { "page": 1, "limit": 20, "total": 4, "totalPages": 1 }
  }
}
```

---

### `POST /withdrawals`

Organizer solicita um novo saque. **Não é uma ação admin.**

**Body:**
```json
{ "amount": 50000, "notes": "Saque parcial" }
```

**Validações:**
- `amount` deve ser > 0
- `amount` ≤ `availableBalance`

**Response (201):**
```json
{
  "data": {
    "withdrawal": {
      "id": "uuid",
      "amount": 50000,
      "feeAmount": 2000,
      "netAmount": 48000,
      "status": "PENDING",
      ...
    }
  }
}
```

---

### `PATCH /withdrawals/:withdrawalId/complete` ⭐ Admin

Aprova e marca o repasse como concluído (transferência realizada).

**Pré-condições:** repasse deve estar `PENDING`.

**Response:**
```json
{
  "message": "Withdrawal completed successfully",
  "data": {
    "withdrawal": { "id": "uuid", "status": "COMPLETED", "completedAt": "2025-04-24T09:00:00Z", ... }
  }
}
```

**Erros possíveis:**
- `404` — repasse não encontrado ou não pertence ao evento
- `400` — repasse não está `PENDING`

---

### `PATCH /withdrawals/:withdrawalId/cancel` ⭐ Admin

Nega/cancela o repasse. O valor retorna ao saldo disponível do organizador.

**Pré-condições:** repasse deve estar `PENDING`.

**Response:**
```json
{
  "message": "Withdrawal cancelled",
  "data": {
    "withdrawal": { "id": "uuid", "status": "CANCELLED", ... }
  }
}
```

**Erros possíveis:**
- `404` — repasse não encontrado
- `400` — repasse não está `PENDING`

---

### `GET /refunded`

Lista pedidos estornados do evento.

**Response:**
```json
{
  "data": {
    "items": [
      {
        "orderId": "uuid",
        "paymentId": "uuid",
        "amount": 15000,
        "paymentMethod": "CREDIT_CARD",
        "purchaseDate": "2025-03-10T11:00:00Z",
        "refundDate": "2025-03-15T09:00:00Z",
        "buyer": { "id": "uuid", "firstName": "Ana", ... }
      }
    ],
    "totalAmount": 30000,
    "pagination": { ... }
  }
}
```

---

### `GET /audit`

Verifica se o evento já foi auditado.

**Response:**
```json
{
  "data": {
    "isAudited": false,
    "audit": null
  }
}
```

Se auditado:
```json
{
  "data": {
    "isAudited": true,
    "audit": {
      "id": "uuid",
      "eventId": "uuid",
      "auditedById": "uuid",
      "retentionReleased": 130000,
      "notes": "Evento encerrado sem pendências",
      "createdAt": "2025-04-24T10:00:00Z"
    }
  }
}
```

---

### `POST /audit` ⭐ Admin

Realiza a auditoria do evento. **Irreversível. Única por evento.**

Libera imediatamente todos os valores em `awaitingAudit` para o saldo disponível.

**Body:**
```json
{ "notes": "Evento auditado — sem ocorrências." }
```

**Response (201):**
```json
{
  "message": "Event audited successfully",
  "data": {
    "audit": {
      "id": "uuid",
      "eventId": "uuid",
      "auditedById": "uuid",
      "retentionReleased": 130000,
      "notes": "Evento auditado — sem ocorrências.",
      "createdAt": "2025-04-24T10:00:00Z"
    }
  }
}
```

**Erros possíveis:**
- `400` — evento já auditado

---

## Endpoints Admin Globais

Base: `GET /api/v1/admin/...`

Exigem `Authorization: Bearer <token>`. Futuramente protegidos por guard de role `ADMIN`.

---

### `GET /api/v1/admin/withdrawals/stats`

Estatísticas globais de todos os repasses da plataforma.

**Response:**
```json
{
  "message": "Withdrawal stats fetched successfully",
  "data": {
    "pending": {
      "count": 5,
      "totalAmount": 250000,
      "totalNetAmount": 240000
    },
    "completed": {
      "count": 12,
      "totalAmount": 600000,
      "totalNetAmount": 576000
    },
    "cancelled": {
      "count": 2,
      "totalAmount": 100000,
      "totalNetAmount": 96000
    },
    "fees": {
      "totalCollected": 24000,
      "avgFeeRate": 0.04,
      "effectiveFeePercent": 4.0
    },
    "overview": {
      "totalEventsWithWithdrawals": 8,
      "totalWithdrawals": 19,
      "totalGrossRequested": 950000
    }
  }
}
```

> Todos os valores monetários estão em **centavos**.

**Campos:**
- `pending.totalAmount` — soma do valor bruto de todos os repasses pendentes
- `completed.totalNetAmount` — soma do valor líquido efetivamente transferido
- `fees.totalCollected` — soma das taxas Podio arrecadadas nos repasses concluídos
- `fees.effectiveFeePercent` — taxa efetiva real: `feeTotal / grossTotal × 100`
- `overview.totalGrossRequested` — total bruto de todos os repasses (qualquer status)

---

### `GET /api/v1/admin/withdrawals?page=1&limit=20`

Listagem global paginada de todos os repasses da plataforma.

**Query params:**

| Param | Tipo | Descrição |
|---|---|---|
| `page` | number | Página (default: 1) |
| `limit` | number | Itens por página, máx 100 (default: 20) |
| `status` | `PENDING` \| `COMPLETED` \| `CANCELLED` | Filtrar por status |
| `eventId` | UUID | Filtrar por evento específico |
| `search` | string | Busca por nome do evento, nome ou email do organizador |

**Response:**
```json
{
  "message": "Withdrawals fetched successfully",
  "data": {
    "withdrawals": [
      {
        "id": "uuid",
        "eventId": "uuid",
        "amount": 50000,
        "feeRate": 0.04,
        "feeAmount": 2000,
        "netAmount": 48000,
        "status": "PENDING",
        "notes": null,
        "completedAt": null,
        "createdAt": "2025-04-22T10:00:00Z",
        "event": {
          "id": "uuid",
          "name": "Corrida 10KM SP",
          "slug": "corrida-10km-sp",
          "organizationId": "uuid",
          "organization": { "id": "uuid", "name": "Run Brasil" }
        },
        "requestedBy": {
          "id": "uuid",
          "firstName": "Carlos",
          "lastName": "Souza",
          "email": "carlos@runbrasil.com"
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 19,
      "totalPages": 1
    }
  }
}
```

**Campos de exibição na tabela:**

| Campo | Origem |
|---|---|
| ID do repasse | `id` |
| Evento | `event.name` + `event.slug` |
| Organização | `event.organization.name` |
| Solicitante | `requestedBy.firstName + lastName` + `email` |
| Valor bruto | `amount` ÷ 100 → R$ |
| Taxa Podio | `feeAmount` ÷ 100 → R$ (`feeRate * 100`%) |
| Valor líquido | `netAmount` ÷ 100 → R$ |
| Status | badge colorido |
| Solicitado em | `createdAt` |
| Concluído em | `completedAt` |

---

## Tela: Dashboard Admin — Cards de Resumo

Consumir `GET /api/v1/admin/withdrawals/stats` para exibir os cards do topo:

```
┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
│  ⏳ Pendentes       │ │  ✅ Concluídos      │ │  ❌ Cancelados      │ │  💰 Taxa Arrecadada │
│  5 repasses        │ │  12 repasses       │ │  2 repasses        │ │  R$ 240,00         │
│  R$ 2.500,00       │ │  R$ 5.760,00 líq.  │ │  R$ 960,00 líq.    │ │  4,0% efetivo      │
└────────────────────┘ └────────────────────┘ └────────────────────┘ └────────────────────┘
```

- Card Pendentes → `pending.count` + `pending.totalAmount / 100`
- Card Concluídos → `completed.count` + `completed.totalNetAmount / 100`
- Card Cancelados → `cancelled.count` + `cancelled.totalNetAmount / 100`
- Card Taxa → `fees.totalCollected / 100` + `fees.effectiveFeePercent`%

---

## Tela: Lista Global de Repasses (Admin)

**Campos recomendados para a listagem global:**

| Campo | Origem |
|---|---|
| ID do repasse | `id` |
| Evento | `event.name` + `event.slug` |
| Organização | `event.organization.name` |
| Solicitante | `requestedBy.firstName + lastName` |
| Valor bruto | `amount` (÷ 100 para exibir em R$) |
| Taxa Podio | `feeAmount` (÷ 100) |
| Valor líquido | `netAmount` (÷ 100) |
| Taxa % | `feeRate * 100`% |
| Status | `status` badge colorido |
| Data de solicitação | `createdAt` |
| Data de conclusão | `completedAt` |

---

## Tela: Detalhe do Repasse

Ao clicar em um repasse da lista, exibir:

```
┌─────────────────────────────────────────┐
│  Repasse #uuid                          │
│  Evento: Corrida 10KM SP                │
│  Organização: Run Brasil                │
├─────────────────────────────────────────┤
│  Solicitante   Carlos Souza             │
│                carlos@runbrasil.com     │
│  Solicitado em 22/04/2025 10:00         │
├─────────────────────────────────────────┤
│  Valor solicitado     R$ 500,00         │
│  Taxa Podio (4%)     -R$  20,00         │
│  Valor líquido        R$ 480,00         │
├─────────────────────────────────────────┤
│  Status  ● PENDING                      │
│  Notas   —                              │
├─────────────────────────────────────────┤
│  [Aprovar Repasse]  [Negar Repasse]     │
└─────────────────────────────────────────┘
```

Os botões de ação só aparecem se `status === "PENDING"`.

---

## Tela: Auditoria de Evento

Só deve ser exibida e habilitada quando o evento já encerrou (`eventDate` no passado).

```
┌────────────────────────────────────────────┐
│  Auditoria — Corrida 10KM SP               │
├────────────────────────────────────────────┤
│  Status        Não auditado                │
│  Retido (10%)  R$ 1.300,00                 │
│  Liberado após auditoria → R$ 1.300,00    │
├────────────────────────────────────────────┤
│  Observação  [___________________________] │
│                                            │
│  ⚠️  Esta ação é irreversível.             │
│  [Realizar Auditoria]                      │
└────────────────────────────────────────────┘
```

Se `isAudited === true`, substituir pelo resumo da auditoria realizada (data, admin, valor liberado, notas).

---

## Erros Comuns

| HTTP | Cenário |
|---|---|
| `400` | Saldo insuficiente ao solicitar saque |
| `400` | Repasse não está `PENDING` (já aprovado ou cancelado) |
| `400` | Evento já auditado (tentativa de segunda auditoria) |
| `403` | Usuário sem permissão `financial` no evento |
| `404` | Repasse não encontrado ou não pertence ao evento |

---

## Resumo dos Endpoints Admin

### Globais (visão plataforma)

| Ação | Endpoint | Método |
|---|---|---|
| Stats globais de repasses | `/api/v1/admin/withdrawals/stats` | `GET` |
| Listagem global de repasses | `/api/v1/admin/withdrawals` | `GET` |

### Por evento

| Ação | Endpoint | Método | Irreversível? |
|---|---|---|---|
| Resumo financeiro | `/api/v1/events/:id/repasse/summary` | `GET` | — |
| Aguardando liberação | `/api/v1/events/:id/repasse/pending` | `GET` | — |
| Parcelas futuras | `/api/v1/events/:id/repasse/installments` | `GET` | — |
| Histórico de saques | `/api/v1/events/:id/repasse/withdrawals` | `GET` | — |
| Aprovar repasse | `/api/v1/events/:id/repasse/withdrawals/:wid/complete` | `PATCH` | Sim |
| Negar repasse | `/api/v1/events/:id/repasse/withdrawals/:wid/cancel` | `PATCH` | Sim |
| Status auditoria | `/api/v1/events/:id/repasse/audit` | `GET` | — |
| Auditar evento | `/api/v1/events/:id/repasse/audit` | `POST` | Sim ⚠️ |

Recomenda-se exibir um **modal de confirmação** antes de aprovar, negar ou auditar.
