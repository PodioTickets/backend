# Estorno pelo Organizador — `POST /events/:eventId/repasse/orders/:orderId/refund`

> **Base URL:** `https://<api-host>/api/v1`
> **Fonte:** `repasse.controller.ts` + `repasse.service.ts` (`refundOrder`) → `payments-refund.service.ts` (`refundOrder`)
> **Atualizado:** 2026-05-30

Permite que um **organizador com permissão financeira** estorne (total) um pedido pago do seu
evento. Reusa **integralmente** o mesmo engine do estorno admin — só muda a porta de entrada
(permissão de organizador em vez de `AdminGuard`).

---

## Resumo

| | |
|---|---|
| Método/rota | `POST /api/v1/events/:eventId/repasse/orders/:orderId/refund` |
| Auth | `JwtAuthGuard` (Bearer obrigatório) |
| Permissão | `financial` sobre o evento (membro da org com permissão financeira) |
| Tipo | Estorno **TOTAL** e **imediato** (sem parcial, sem agendamento) |
| Idempotência | Não — chamar 2× em pedido já estornado retorna `409` |
| Efeitos | void na Cielo + `REFUNDED` + cancela pedido/inscrições + reverte cupom/voucher + taxa de refund 2% |

> **Quem pode chamar:** qualquer usuário com permissão `financial` no evento (mesma checada por
> `GET /events/:eventId/repasse/*`). Admin continua tendo a rota própria
> `POST /admin/orders/:id/refund` — as duas usam o mesmo engine.

---

## Request

```
POST /api/v1/events/{eventId}/repasse/orders/{orderId}/refund
Authorization: Bearer <token>
Content-Type: application/json
```

| Param | Onde | Tipo | Obrigatório |
|---|---|---|---|
| `eventId` | path | UUID | sim |
| `orderId` | path | UUID | sim |

**Body** (`RefundOrderDto`):

```jsonc
{
  "reason": "Solicitação do cliente — evento adiado",  // OBRIGATÓRIO, 3–500 chars (vai pro audit log + metadata)
  "force": false                                        // OPCIONAL — aceito por compat, NÃO altera o comportamento
}
```

> `reason` é obrigatório (mín. 3 caracteres). `force` pode ser omitido — o estorno **nunca** é
> bloqueado por saldo (o saldo do organizador pode ficar negativo, e isso é esperado quando o
> valor já foi sacado).

```bash
curl -X POST "https://<api-host>/api/v1/events/$EVENT/repasse/orders/$ORDER/refund" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Cliente desistiu da inscrição"}'
```

---

## Resposta de sucesso — `201`

```jsonc
{
  "message": "Estorno realizado com sucesso",
  "data": {
    "orderId": "4c45...",
    "paymentId": "9a1b...",
    "cieloStatus": "Voided",      // status retornado pela Cielo
    "pendingConfirmation": false, // ver abaixo
    "amount": 6120,               // valor estornado em CENTAVOS (= order.finalAmount)
    "method": "CREDIT_CARD",      // PIX | CREDIT_CARD | DEBIT_CARD
    "refundedAt": "2026-05-30T19:40:00.000Z"
  }
}
```

### ⚠️ `pendingConfirmation`
- `false` → estorno **confirmado** pela Cielo na hora (pedido já está `REFUNDED`).
- `true` → a Cielo **aceitou** mas a confirmação é **assíncrona** (alguns PIX). O pedido vira
  `REFUNDED` quando o **webhook** confirmar. `message` muda para *"Estorno enviado à Cielo e
  aguardando confirmação assíncrona"*. **No front:** trate como "estorno em processamento" e
  atualize o status via refetch (a lista `GET /events/:eventId/repasse/refunded` reflete quando concluir).

---

## Erros

Todos no envelope padrão de exceção (`{ statusCode, message, ... }`). Os do engine trazem um
`code` legível; o de propriedade do evento é mensagem simples.

| HTTP | code | Quando |
|---|---|---|
| `401` | — | sem token / token inválido |
| `403` | — | usuário **sem permissão financeira** sobre o evento |
| `404` | — | `Pedido não encontrado neste evento` (não existe **ou** é de outro evento) |
| `404` | `ORDER_NOT_FOUND` | pedido inexistente (engine) |
| `409` | `ORDER_NOT_PAID` | pedido não está `PAID` (status atual no message) |
| `409` | `PAYMENT_NOT_PAID` | pagamento não está `PAID` (ex.: já estornado) |
| `409` | `PAYMENT_MISSING` / `CIELO_PAYMENT_ID_MISSING` | estado inconsistente / sem referência Cielo |
| `422` | `METHOD_NOT_REFUNDABLE` | método não estornável via API (BOLETO/CRYPTO → devolução manual) |
| `400` | — | a Cielo recusou a operação |

> **Re-estorno:** chamar de novo um pedido já estornado → `409 PAYMENT_NOT_PAID` (o pagamento já é
> `REFUNDED`). O front deve desabilitar o botão após o sucesso.

---

## Efeitos colaterais (o que o estorno faz)

Tudo numa transação (fonte única `PaymentsRefundService` + `OrderFinalizationService.reverseSaleSideEffects`):

1. **Cielo:** void total (`PUT /v2/sales/{paymentId}/void`).
2. **Pagamento:** `status = REFUNDED`, `refundType = REFUND`, `refundedAt` gravado.
3. **Pedido:** cancelado.
4. **Inscrições:** as inscrições do pedido são canceladas.
5. **Cupom/voucher:** uso revertido (decrementa `usageCount` / libera voucher) — espelha o que o pagamento consumiu.
6. **Repasse:** cobra a **taxa de refund (2%)** do organizador; o `orgNet` sai de `paidOrders`
   (clawback implícito). O `saldoParaSaque` pode ficar **negativo** (esperado se já houve saque).
7. **Auditoria:** `OrganizationAuditLog` com `actorUserId` = **organizador** que chamou.

---

## Integração no frontend — checklist

1. **Botão "Estornar"** só visível para quem tem permissão financeira (a UI já sabe disso pelas
   demais telas de repasse). Backend revalida (403 se não tiver).
2. **Confirmação obrigatória** antes de chamar (ação irreversível) + capturar o `reason` (≥ 3 chars)
   num input/textarea → enviar no body.
3. **POST** na rota. Em `201`:
   - `pendingConfirmation === false` → mostrar "Estornado" e refetch da lista de estornados.
   - `pendingConfirmation === true` → mostrar "Estorno em processamento" e refetch/poll até refletir.
4. **Tratar erros** pelo `code` (tabela acima). `409 PAYMENT_NOT_PAID` = já estornado → atualizar o estado.
5. **Não reenviar** após sucesso (não é idempotente). Desabilitar o botão.
6. **Valores em centavos** (`amount`).

---

## Notas

- **Mesma lógica do admin:** qualquer regra/efeito do estorno é idêntico ao `POST /admin/orders/:id/refund`.
  A única diferença é a autorização (financeira do evento vs admin) e a validação extra de que o
  pedido pertence ao `:eventId` da rota (fecha IDOR).
- **Cache:** rota `POST` (não cacheável).
- **Sem migration / sem prisma generate** — mudança apenas de controller/service/módulo.
