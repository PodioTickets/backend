# Frontend — Checkout Integration v2

> Atualizado em: 2026-04-20
> Cobre todas as mudanças na API de pedidos, cupons, produtos e registrations.

---

## 1. Fluxo de checkout

```
POST   /api/v1/orders/reserve              → cria o pedido PENDING, reserva ingressos
PATCH  /api/v1/orders/:id/participants     → salva participantes (auto-aplica cupom QUANTITY/AGE)
PATCH  /api/v1/orders/:id/products        → salva produtos adicionais (opcional)
PATCH  /api/v1/orders/:id/billing-address → salva endereço de cobrança
PATCH  /api/v1/orders/:id/coupon          → aplica/remove cupom DISCOUNT ou voucher (NOVO)
POST   /api/v1/orders/:id/pay             → processa pagamento
```

> **Regra**: `finalAmount` é o valor real a cobrar. `totalAmount` é o bruto sem descontos.

---

## 2. Shape do pedido (Order)

Todos os endpoints retornam o mesmo shape base:

```jsonc
{
  "id": "uuid",
  "eventId": "uuid",
  "status": "PENDING" | "PAID" | "CANCELLED",
  "totalAmount": 29800,     // bruto em centavos (ingressos + produtos)
  "serviceFee": 0,
  "discount": 5960,         // desconto total em centavos
  "finalAmount": 23840,     // ← valor real a cobrar (totalAmount - discount)
  "expiresAt": "...",
  "reservedAt": "...",

  // cupom aplicado (null se nenhum)
  "coupon": {
    "id": "uuid",
    "code": "DESCONTO20",   // null em cupons automáticos
    "couponType": "DISCOUNT" | "QUANTITY" | "AGE",
    "type": "PERCENTAGE" | "FIXED",
    "value": 20             // % ou centavos
  },

  // voucher aplicado (null se nenhum)
  "voucher": {
    "id": "uuid",
    "code": "VOUCHER-XYZ",
    "name": "Voucher Patrocinador",
    "status": "ACTIVE"
  },

  // ingressos com desconto distribuído proporcionalmente
  "reservedTickets": [
    {
      "id": "uuid",
      "ticketId": "uuid",
      "ticketName": "Meia entrada",
      "batchId": "uuid",
      "quantity": 2,
      "unitPrice": 14900,       // preço bruto unitário do lote
      "unitDiscount": 2980,     // desconto unitário proporcional
      "totalDiscount": 5960,    // desconto total deste ticket
      "finalUnitPrice": 11920,  // preço final por unidade
      "finalTotalPrice": 23840  // preço final total
    }
  ],

  "pendingParticipants": [...],
  "pendingProducts": [...],
  "billingPostalCode": "01310-100",
  "createdAt": "...",
  "updatedAt": "...",
  "serverTime": "..."
}
```

---

## 3. PATCH /orders/:id/participants (atualizado)

Ao salvar participantes, o backend **auto-aplica cupons QUANTITY e AGE** se as condições forem satisfeitas — sem nenhuma ação extra do frontend.

**Cupom QUANTITY**: aplicado se `total de ingressos >= minQuantity` do cupom.  
**Cupom AGE**: aplicado se todos os participantes têm idade dentro do range do cupom.

Quando auto-aplicado, a resposta já traz `coupon`, `discount` e `finalAmount` atualizados:

```jsonc
{
  "totalAmount": 29800,
  "discount": 5960,
  "finalAmount": 23840,         // ← atualizado automaticamente
  "coupon": {
    "couponType": "QUANTITY",
    "type": "PERCENTAGE",
    "value": 20
  },
  "reservedTickets": [
    {
      "unitPrice": 14900,
      "unitDiscount": 2980,
      "finalUnitPrice": 11920,
      "finalTotalPrice": 23840
    }
  ]
}
```

O frontend deve verificar se `coupon !== null` na resposta e exibir o desconto aplicado.

---

## 4. PATCH /orders/:id/coupon (NOVO)

Endpoint para cupons manuais (código digitado pelo usuário) e vouchers.

### Aplicar cupom

```http
PATCH /api/v1/orders/:orderId/coupon
Content-Type: application/json

{ "couponCode": "DESCONTO20" }
```

### Aplicar voucher

```http
PATCH /api/v1/orders/:orderId/coupon
Content-Type: application/json

{ "voucherCode": "VOUCHER-XYZ" }
```

### Remover cupom ou voucher

```http
PATCH /api/v1/orders/:orderId/coupon
Content-Type: application/json

{}
```

### Resposta de sucesso

```jsonc
{
  // ...shape completo do pedido...
  "finalAmount": 23840,
  "coupon": { "id": "...", "code": "DESCONTO20", "type": "PERCENTAGE", "value": 20, ... },
  "appliedDiscount": {
    "type": "coupon" | "voucher" | null,
    "discount": 5960
  }
}
```

### Erros

| Status | Code | Descrição |
|---|---|---|
| 409 | `ORDER_NOT_PENDING` | Pedido não está mais pendente |
| 422 | `COUPON_NOT_FOUND` | Cupom inválido ou inexistente |
| 422 | `COUPON_EXPIRED` | Cupom expirado |
| 422 | `COUPON_MIN_VALUE` | Pedido abaixo do valor mínimo do cupom |
| 422 | `VOUCHER_NOT_FOUND` | Voucher inválido ou inexistente |
| 422 | `VOUCHER_EXPIRED` | Voucher expirado |
| 422 | `DISCOUNT_CONFLICT` | Cupom e voucher não podem ser usados juntos |

---

## 5. totalAmount vs finalAmount

| Campo | Quando muda | O que representa |
|---|---|---|
| `totalAmount` | `PATCH /products` | Bruto: ingressos + produtos |
| `discount` | `PATCH /participants`, `PATCH /coupon` | Total descontado em centavos |
| `finalAmount` | `PATCH /products`, `PATCH /participants`, `PATCH /coupon` | **Valor real a cobrar** |

Exibir sempre `finalAmount` ao usuário. Usar `totalAmount` apenas como "subtotal antes do desconto".

> **Atenção**: se o usuário editar produtos após cupom aplicado (`PATCH /products`), o `finalAmount` volta ao bruto. Chame `PATCH /coupon` novamente para reaplicar.

---

## 6. POST /orders/:id/pay — retry de cartão (MUDANÇA IMPORTANTE)

**Antes**: erro no cartão → pedido cancelado.  
**Agora**: erro no cartão → pedido permanece `PENDING`, usuário pode tentar novamente.

```
POST /pay → 402 PAYMENT_REFUSED  →  mostrar erro, deixar corrigir e tentar de novo
          → 201 OK               →  pagamento aprovado
          → 409 ORDER_NOT_PENDING →  pedido expirou ou foi pago em outra aba
```

**Nunca redirecionar para "pedido cancelado" em caso de 402.**

```jsonc
// Resposta 402
{
  "error": true,
  "code": "PAYMENT_REFUSED",
  "message": "Pagamento recusado. Verifique os dados e tente novamente."
}
```

---

## 7. Breakdown de desconto por ingresso

Use os campos de `reservedTickets` para exibir o detalhamento:

```
Ingresso: Meia entrada (×2)
  Preço unitário:  R$ 149,00
  Desconto (20%): - R$ 29,80
  Preço final:     R$ 119,20
  ─────────────────────────
  Total:           R$ 238,40

Cupom: DESCONTO20 (20% off)
```

---

## 8. Registrations — PENDING removidas da listagem

`GET /api/v1/events/:slug/registrations` não retorna mais registrations com status `PENDING`.

Registrations PENDING são placeholders internos criados na reserva e não devem ser exibidas.

---

## 9. Buyer acessa suas próprias registrations

O comprador (userId do pedido) agora pode acessar `GET /api/v1/registrations/:id` mesmo quando o participante é outra pessoa.

---

## 10. Upload de imagens de produtos

- Limite aumentado de **5 → 7 imagens** por produto
- Imagens salvas sem transcodificação (qualidade original preservada)

```json
{
  "images": ["data:image/jpeg;base64,..."],
  "primaryImageIndex": 0
}
```

---

## 11. Busca accent-insensitive

`GET /api/v1/events/search?q=atletismo` encontra "Atletísmo" sem precisar de acento. Sem mudança de contrato.

---

## 12. Checklist de integração

- [ ] Verificar `coupon` na resposta de `PATCH /participants` e exibir desconto auto-aplicado
- [ ] Implementar campo de cupom manual → `PATCH /coupon` com `{ couponCode }`
- [ ] Implementar campo de voucher → `PATCH /coupon` com `{ voucherCode }`
- [ ] Botão "remover desconto" → `PATCH /coupon` com `{}`
- [ ] Exibir `finalAmount` como valor total (não `totalAmount`)
- [ ] Em caso de **402** no `POST /pay`, não cancelar o pedido — permitir retry
- [ ] Usar `finalUnitPrice` / `finalTotalPrice` de `reservedTickets` para breakdown por ingresso
- [ ] Atualizar limite de imagens de produtos para 7
