# Repasse — Guia de Integração Frontend

Base URL: `https://api.seudominio.com/api/v1/events/:eventId/repasse`

Todos os endpoints exigem `Authorization: Bearer <token>` do organizador.  
Todos os valores monetários estão em **centavos** (integer). Ex: `8640` = R$ 86,40.

---

## Sumário dos Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/summary` | Resumo financeiro completo |
| GET | `/pending` | Aguardando liberação (prazo + retenção 10%) |
| GET | `/installments` | Parcelados a receber |
| GET | `/withdrawals` | Histórico de saques |
| POST | `/withdrawals` | Solicitar saque |
| PATCH | `/withdrawals/:id/complete` | [Admin] Confirmar saque |
| PATCH | `/withdrawals/:id/cancel` | [Admin] Cancelar saque |
| GET | `/refunded` | Pedidos estornados |
| GET | `/audit` | Status da auditoria |
| POST | `/audit` | [Admin] Realizar auditoria |

---

## GET /summary

**Tela:** Dashboard financeiro principal.

### Response
```json
{
  "message": "Repasse summary fetched successfully",
  "data": {
    "summary": {
      "grossRevenue": 100000,
      "availableBalance": 8640,
      "pendingRelease": 10000,
      "awaitingAudit": 1000,
      "installmentsToReceive": 5000,
      "releasedAndAvailable": 9000,
      "totalWithdrawn": 8640,
      "refundedOrders": 1,
      "isAudited": false,
      "auditedAt": null,
      "retentionReleased": 0,
      "organizerFeeRate": 0.04,
      "retentionRate": 0.10
    }
  }
}
```

### Campos explicados

| Campo | Descrição |
|-------|-----------|
| `grossRevenue` | Receita bruta total (todos os pagos) |
| `availableBalance` | **Saldo disponível para sacar agora** |
| `pendingRelease` | Pedidos dentro do prazo (PIX: 24h, Cartão: 30d) — ainda bloqueados |
| `awaitingAudit` | 10% retido (ou última parcela) — liberado apenas na auditoria |
| `installmentsToReceive` | Parcelas futuras ainda não vencidas |
| `releasedAndAvailable` | Liberado mas ainda não sacado |
| `totalWithdrawn` | Total já sacado (saques COMPLETED) |
| `refundedOrders` | Quantidade de pedidos estornados |
| `isAudited` | Se o evento já foi auditado |
| `organizerFeeRate` | Taxa Podio (ex: `0.04` = 4%) |
| `retentionRate` | Percentual retido até auditoria (ex: `0.10` = 10%) |

### Cálculo do saldo disponível
```
availableBalance = releasedAndAvailable - totalWithdrawn
```

---

## GET /pending?page=1&limit=20

**Tela:** "Aguardando Liberação"

### Response
```json
{
  "data": {
    "items": [
      {
        "orderId": "uuid",
        "paymentId": "uuid",
        "transactionId": "mp-123",
        "type": "AWAITING_RELEASE",
        "amount": 10000,
        "retainedAmount": null,
        "paymentMethod": "PIX",
        "purchaseDate": "2026-04-22T10:00:00.000Z",
        "paymentDate": "2026-04-22T10:05:00.000Z",
        "releaseDate": "2026-04-23T10:05:00.000Z",
        "daysUntilRelease": 1,
        "buyer": { "firstName": "João", "email": "joao@email.com", ... }
      },
      {
        "orderId": "uuid",
        "type": "AWAITING_AUDIT",
        "amount": 10000,
        "retainedAmount": 1000,
        "daysUntilRelease": 0,
        ...
      }
    ],
    "totalRetained": 1000,
    "totalPendingRelease": 10000,
    "pagination": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 }
  }
}
```

### Tipos de item (`type`)

| Tipo | Significa |
|------|-----------|
| `AWAITING_RELEASE` | Dentro do prazo (24h/30d) — valor total bloqueado |
| `AWAITING_AUDIT` | Prazo passou, mas 10% retido aguardando auditoria |

### Exibição sugerida
- `AWAITING_RELEASE`: mostrar `amount` completo com countdown `daysUntilRelease`
- `AWAITING_AUDIT`: mostrar `retainedAmount` com badge "Aguardando Auditoria"

---

## GET /installments?page=1&limit=20

**Tela:** "Parcelados a Receber"

### Response
```json
{
  "data": {
    "items": [
      {
        "id": "uuid-installment-2",
        "orderId": "uuid",
        "paymentId": "uuid",
        "installmentNumber": 2,
        "totalInstallments": 5,
        "amount": 2000,
        "dueDate": "2026-05-22T10:00:00.000Z",
        "isLastInstallment": false,
        "retainedUntilAudit": false,
        "buyer": { ... }
      },
      {
        "installmentNumber": 5,
        "isLastInstallment": true,
        "retainedUntilAudit": true,
        "amount": 2000,
        ...
      }
    ],
    "totalPending": 8000,
    "pagination": { ... }
  }
}
```

### Atenção
- `retainedUntilAudit: true` → última parcela, mostrar badge "Retida até Auditoria"
- Quando `isAudited = true` (via `/summary`), a última parcela vai para `availableBalance` ao vencer

---

## GET /withdrawals?page=1&limit=20

**Tela:** "Histórico de Repasses"

### Response
```json
{
  "data": {
    "withdrawals": [
      {
        "id": "uuid",
        "eventId": "uuid",
        "amount": 9000,
        "feeRate": 0.04,
        "feeAmount": 360,
        "netAmount": 8640,
        "status": "COMPLETED",
        "notes": null,
        "completedAt": "2026-04-23T14:00:00.000Z",
        "createdAt": "2026-04-22T20:00:00.000Z",
        "requestedBy": { "firstName": "Org", "email": "org@email.com" }
      }
    ],
    "totalNetWithdrawn": 8640,
    "pagination": { ... }
  }
}
```

### Status possíveis

| Status | Descrição |
|--------|-----------|
| `PENDING` | Aguardando processamento pela Podio |
| `COMPLETED` | Transferência realizada |
| `CANCELLED` | Cancelado |

---

## POST /withdrawals — Solicitar Saque

**Body:**
```json
{
  "amount": 9000
}
```
> `amount` em centavos. Deve ser ≤ `availableBalance` retornado em `/summary`.

**Response (201):**
```json
{
  "message": "Withdrawal requested successfully",
  "data": {
    "withdrawal": {
      "id": "uuid",
      "amount": 9000,
      "feeRate": 0.04,
      "feeAmount": 360,
      "netAmount": 8640,
      "status": "PENDING",
      "createdAt": "2026-04-22T20:00:00.000Z"
    }
  }
}
```

**Erros:**
- `400` — saldo insuficiente ou valor inválido
- `401` — não autenticado
- `403` — sem permissão `financial`

### UX sugerida
Antes de mostrar o botão "Solicitar Saque", exibir:
```
Saldo disponível: R$ 90,00
Taxa Podio (4%):  R$  3,60
Você receberá:    R$ 86,40
```

---

## PATCH /withdrawals/:id/complete — [Admin] Confirmar Saque

Sem body obrigatório. Muda status `PENDING → COMPLETED`.

```http
PATCH /api/v1/events/:eventId/repasse/withdrawals/:withdrawalId/complete
```

---

## PATCH /withdrawals/:id/cancel — [Admin] Cancelar Saque

Muda status `PENDING → CANCELLED`. O valor volta para `availableBalance`.

```http
PATCH /api/v1/events/:eventId/repasse/withdrawals/:withdrawalId/cancel
```

---

## GET /refunded

**Tela:** "Estornados"

### Response
```json
{
  "data": {
    "items": [
      {
        "orderId": "uuid",
        "paymentId": "uuid",
        "amount": 10000,
        "paymentMethod": "PIX",
        "purchaseDate": "2026-04-10T...",
        "refundDate": "2026-04-15T...",
        "buyer": { "firstName": "João", ... }
      }
    ],
    "totalAmount": 10000,
    "pagination": { ... }
  }
}
```

### Cenários de exibição (conforme repasse.md)
- **Antes do saque**: pedido aparece só aqui (saiu de "aguardando")
- **Após saque dos 90%**: aparece aqui E no histórico de repasse
- Mostrar nota: "A Podio absorve o prejuízo e reconcilia na auditoria"

---

## GET /audit

```json
{
  "data": {
    "isAudited": false,
    "audit": null
  }
}
```

Quando auditado:
```json
{
  "data": {
    "isAudited": true,
    "audit": {
      "id": "uuid",
      "eventId": "uuid",
      "retentionReleased": 1000,
      "notes": "Evento realizado com sucesso",
      "createdAt": "2026-05-01T..."
    }
  }
}
```

---

## POST /audit — [Admin] Realizar Auditoria

**Body (opcional):**
```json
{
  "notes": "Evento realizado em 30/04/2026"
}
```

**Efeito:**
- Libera os 10% retidos (ou última parcela) para `availableBalance`
- Operação irreversível (um evento só pode ser auditado uma vez)
- `retentionReleased` registra o valor liberado

**Response:**
```json
{
  "message": "Event audited successfully",
  "data": {
    "audit": {
      "id": "uuid",
      "retentionReleased": 1000,
      "createdAt": "2026-05-01T..."
    }
  }
}
```

---

## Fluxo completo por método de pagamento

### PIX (R$100)

```
Compra realizada
  └─ pendingRelease: R$100   (durante 24h)
     └─ Após 24h:
        ├─ availableBalance: R$90   (disponível para saque)
        └─ awaitingAudit: R$10     (retido)
           └─ Saque de R$90 → netAmount: R$86,40 (4% de taxa)
              └─ Após auditoria: R$10 → availableBalance
```

### Cartão à vista (R$100)

```
Compra realizada
  └─ pendingRelease: R$100   (durante 30 dias)
     └─ Após 30 dias:
        ├─ availableBalance: R$90
        └─ awaitingAudit: R$10
           └─ Se auditoria ANTES do saque: R$100 disponível direto
```

### Cartão parcelado 5x (R$100 = 5x R$20)

```
Compra realizada
  └─ installmentsToReceive: R$80  (parcelas 2-5 futuras)
     └─ Parcelas 1-4 vencem mês a mês → availableBalance
     └─ Parcela 5 (última): retainedUntilAudit = true
        └─ Após auditoria: vai direto para availableBalance quando vencer
```

---

## Códigos de erro

| Código | Situação |
|--------|----------|
| `400` | Saldo insuficiente, evento já auditado, saque não está PENDING |
| `401` | Token ausente/inválido |
| `403` | Usuário não tem permissão `financial` no evento |
| `404` | Evento ou saque não encontrado |
