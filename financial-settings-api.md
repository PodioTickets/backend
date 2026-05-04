# API: Configurações Financeiras do Evento

> Documento gerado a partir da página `/organizer/events/new/financial`.  
> Descreve o que o servidor precisa implementar para persistir e retornar as configurações financeiras de um evento.

---

## Contexto

A página de Financeiro (`/organizer/events/new/financial`) permite ao organizador configurar:

1. **Divisão da taxa da plataforma** — taxa total fixa de **6%**, dividida entre organizador e participante.
2. **Parcelamento máximo no cartão de crédito** — 1, 2 ou 3 vezes sem juros.

Atualmente o frontend exibe e manipula esses dados apenas localmente (estado React). Nenhum desses campos é enviado ao servidor nem está no modelo de evento. Todas as integrações abaixo precisam ser implementadas.

---

## 1. Novos campos no modelo de Evento

| Campo | Tipo | Restrições | Descrição |
|---|---|---|---|
| `organizerFeePercent` | `number` (float) | `0.0 – 6.0`, duas casas decimais | Percentual da taxa de 6% que o organizador absorve. O participante paga o complemento (`6 - organizerFeePercent`). |
| `maxInstallments` | `integer` | `1 \| 2 \| 3` | Número máximo de parcelas sem juros aceitas no cartão de crédito. |

> **Nota sobre taxa:** A taxa total da plataforma é sempre **6%** (`TOTAL_FEE`). O campo `participantFeePercent` não precisa ser armazenado — é sempre `6 - organizerFeePercent` e pode ser calculado on-the-fly.

---

## 2. Formas de pagamento

Na UI atual, **PIX**, **Cartão de débito** e **Cartão de crédito** são sempre exibidos (sem toggles — todos habilitados). O servidor deve garantir que o evento suporte esses três métodos por padrão.

Se no futuro o organizador puder desativar métodos individualmente, sugerimos um array `acceptedPaymentMethods: ("PIX" | "DEBIT_CARD" | "CREDIT_CARD")[]`. Por ora, o valor padrão é `["PIX", "DEBIT_CARD", "CREDIT_CARD"]`.

---

## 3. Endpoints necessários

### 3.1 Salvar configurações financeiras

```
PATCH /api/v1/events/{eventId}/financial-settings
```

**Headers:**
```
Authorization: Bearer <token>
Content-Type: application/json
```

**Request body:**
```json
{
  "organizerFeePercent": 3.0,
  "maxInstallments": 2
}
```

**Validações:**
- `organizerFeePercent`: obrigatório, float, `0.0 ≤ x ≤ 6.0`
- `maxInstallments`: obrigatório, integer, um dos valores `1 | 2 | 3`
- O endpoint deve retornar **409 Conflict** (ou **422 Unprocessable Entity**) se o evento já estiver publicado (ver seção 4 — Lock)

**Response `200 OK`:**
```json
{
  "data": {
    "eventId": "uuid",
    "organizerFeePercent": 3.0,
    "participantFeePercent": 3.0,
    "maxInstallments": 2,
    "acceptedPaymentMethods": ["PIX", "DEBIT_CARD", "CREDIT_CARD"],
    "lockedAt": null
  }
}
```

**Response `409 Conflict` (evento publicado):**
```json
{
  "error": "FINANCIAL_SETTINGS_LOCKED",
  "message": "As configurações financeiras não podem ser alteradas após a publicação do evento."
}
```

---

### 3.2 Buscar configurações financeiras

```
GET /api/v1/events/{eventId}/financial-settings
```

**Response `200 OK`:**
```json
{
  "data": {
    "eventId": "uuid",
    "organizerFeePercent": 3.0,
    "participantFeePercent": 3.0,
    "maxInstallments": 2,
    "acceptedPaymentMethods": ["PIX", "DEBIT_CARD", "CREDIT_CARD"],
    "lockedAt": "2025-05-01T12:00:00Z"
  }
}
```

> `lockedAt` é `null` enquanto o evento não estiver publicado, e preenchido com a data de publicação quando bloqueado.

---

### 3.3 Criação do evento (ajuste no endpoint existente)

O endpoint de criação (`POST /api/v1/events`) pode aceitar esses campos opcionalmente no body para rascunhos:

```json
{
  "...outros campos...",
  "organizerFeePercent": 0.0,
  "maxInstallments": 1
}
```

Se não informados, o servidor deve assumir os defaults:
- `organizerFeePercent`: `0.0` (toda a taxa recai sobre o participante)
- `maxInstallments`: `1`

---

## 4. Regra de Lock (bloqueio após publicação)

**A UI exibe o aviso:** _"Estes dados ficam travados após a publicação."_

Ao publicar o evento:
- O servidor deve registrar `lockedAt = now()` no registro de configurações financeiras.
- Qualquer chamada `PATCH /api/v1/events/{eventId}/financial-settings` após `lockedAt != null` deve ser rejeitada com **409**.

---

## 5. Mudanças necessárias no frontend

Após a implementação server-side, o frontend precisará:

1. **`CreateEventFormData`** — adicionar os campos:
   ```ts
   organizerFeePercent?: number; // 0–6
   maxInstallments?: 1 | 2 | 3;
   ```

2. **`financial/page.tsx`** — ao clicar em "Salvar rascunho" ou "Publicar", chamar `PATCH /api/v1/events/{eventId}/financial-settings` com os valores atuais do estado (`organizerPercent`, `maxInstallments`).

3. **Carregamento** — ao entrar na página (evento já criado como rascunho), buscar `GET /api/v1/events/{eventId}/financial-settings` e inicializar o estado local com os valores retornados.

4. **Lock no UI** — se `lockedAt != null`, desabilitar o slider e os botões de parcelamento (read-only).

---

## 6. Resumo de tipos (TypeScript)

```ts
// Payload para salvar
interface FinancialSettingsPayload {
  organizerFeePercent: number;   // 0.0 – 6.0
  maxInstallments: 1 | 2 | 3;
}

// Resposta do servidor
interface FinancialSettingsResponse {
  eventId: string;
  organizerFeePercent: number;
  participantFeePercent: number;
  maxInstallments: 1 | 2 | 3;
  acceptedPaymentMethods: ("PIX" | "DEBIT_CARD" | "CREDIT_CARD")[];
  lockedAt: string | null;       // ISO 8601, null se não publicado
}
```
