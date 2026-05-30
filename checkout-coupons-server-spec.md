# Checkout — Cupons / Vouchers / Cupom de idade 100% server-driven

> **Objetivo:** o frontend deixa de recalcular preço/cupom/idade e passa a **exibir
> apenas o `pricing` do servidor** em todas as etapas. Editar um participante (idade)
> deve refletir no desconto. Hoje o cupom de idade é avaliado pela conta do **comprador**,
> não pelos **participantes**, e o front recomputa client-side → divergências.
> **Atualizado:** 2026-05-30

---

## 1. Problema atual  *(status backend 2026-05-30)*

1. ~~**Cupom de idade (AGE) é keyed no comprador.**~~ ✅ **RESOLVIDO.** A elegibilidade no checkout
   é avaliada **por participante** (data de nascimento de cada um, na data do evento). O endpoint
   legado `GET /coupons/events/:eventId/age-eligibility` ainda usa a conta logada, mas virou
   redundante — a verdade é o `pricing` recomputado.
2. ~~**`PATCH /participants` / `PATCH /products` não recomputam** os cupons automáticos.~~
   ✅ **RESOLVIDO.** Ambos (re)avaliam e aplicam os cupons automáticos (AGE/QUANTITY) via a
   fonte única `evaluateAutoCoupons`, e devolvem o `pricing` recomputado. Atribuir/editar
   participante reflete na hora.
3. O front recomputa cupom/idade/taxa/total em `/ingressos`, `/informacoes` e `/produtos`
   (espelhando a regra do backend) — fonte das divergências. **(A fazer no front — §4.)**

## 2. Princípio

**O servidor é a única fonte da verdade de preço.** Toda mutação da order (`reserve`,
`PATCH participants`, `PATCH products`, `PATCH coupon`) deve **recomputar e devolver o
`pricing` final** já refletindo: cupom manual (link), voucher, **cupom automático de idade
avaliado por participante**, cupom de quantidade, taxa de serviço e total. O front só exibe.

---

## 3. Mudanças exigidas no BACKEND

### 3.1 Cupom de idade avaliado POR PARTICIPANTE
- Para cada ticket reservado, a elegibilidade do cupom de idade é avaliada pela **data de
  nascimento do participante atribuído àquele ticket** (não pela conta do comprador).
- A idade é calculada **na data do evento** (mesma convenção do front: `computeAgeOnEvent`).
- Multi-participante: cada unidade qualificada recebe o desconto; unidades não-qualificadas
  ficam com preço cheio. O `pricing` agrega o total.
- Enquanto um ticket **não tem participante** atribuído, o cupom de idade **não** se aplica
  àquela unidade (evita prometer desconto que pode sumir).

### 3.2 Recompute em TODA mutação, devolvendo `pricing` autoritativo
Endpoints que já existem e **devem** retornar o `pricing` recomputado:
- `POST /orders/reserve`
- `PATCH /orders/:id/participants`  ← **principal**: ao mudar/editar participante, reavalia AGE.
- `PATCH /orders/:id/products`
- `PATCH /orders/:id/coupon` (e voucher)
- `GET /orders/:id`

O `pricing` deve ser **idêntico** ao que será cobrado no `POST /pay` (mesma engine).

### 3.3 Shape do `pricing` (centavos, inteiros) — breakdown rotulado
Hoje o front recebe `pricing.{subtotal, serviceFee, couponDiscount, voucherDiscount, total}`
(ver `useCheckoutReservation.toOrderResponse`). Para o front parar de recomputar e renderizar
as **linhas rotuladas** sem inferir nada, o backend deve enviar:

```jsonc
"pricing": {
  "ticketsSubtotal":   30000,   // ingressos antes de desconto
  "productsSubtotal":   5000,   // produtos antes de desconto
  "subtotal":          35000,   // tickets + products
  "couponDiscount":    15000,   // QUALQUER cupom (manual/link, idade, quantidade)
  "voucherDiscount":    0,      // voucher (entidade à parte do cupom)
  "serviceFee":         600,    // taxa sobre o subtotal JÁ DESCONTADO
  "total":            20600,    // = finalAmount cobrado
  "currency": "BRL"
}
```

> **Cupom é cupom.** Não há linha separada por tipo de cupom: o desconto de **qualquer**
> cupom (`DISCOUNT` manual/link, `AGE` idade, `QUANTITY`) entra em **`couponDiscount`**. Se o
> front quiser rotular o tipo, lê `coupon.couponType` no objeto `coupon` (ver §3.4). Apenas o
> **voucher** tem balde próprio (`voucherDiscount`), por ser outra entidade.
>
> **Regras de consistência** (o front confia nelas, não recalcula):
> - `serviceFee` incide sobre `subtotal - (couponDiscount + voucherDiscount)`.
> - `total = subtotal - couponDiscount - voucherDiscount + serviceFee`.
> - `couponDiscount + voucherDiscount` == o `discount` total do pedido (campo flat legado).
> - Cupom e voucher são **mutuamente exclusivos** (no combinado legado a divisão é aproximada,
>   mas a SOMA sempre bate).
> - Valores em **centavos** (FIXED também), nunca negativos.

> **Status backend (2026-05-30):** ✅ Implementado. `pricing` é retornado por `reserve`,
> `GET /orders/:id`, `PATCH /participants`, `PATCH /products` e `PATCH /coupon` (via `orderShape`).
> Aditivo — os campos flat antigos (`totalAmount`/`serviceFee`/`discount`/`finalAmount`) seguem.

### 3.4 Metadados dos descontos (para os rótulos)
Manter/retornar, para o front rotular as linhas:
- `coupon`: objeto único do cupom aplicado (qualquer tipo). Inclui `code`, **`couponType`**
  (`"DISCOUNT"|"AGE"|"QUANTITY"`), `type` (`"PERCENTAGE"|"FIXED"`), `value`, `appliesTo`,
  `minAge`/`maxAge` (quando AGE), `applyToProducts`. **É daqui que o front decide o rótulo**
  (ex.: `couponType==="AGE"` → "Cupom automático (X% OFF)"). NÃO há objeto `ageCoupon` separado.
- `voucher`: `{ code, name, ... }`.
- `couponAutoRemoved: boolean` quando um cupom **automático** (AGE/QUANTITY) cai por mudança de
  carrinho/participantes (sempre presente; default `false`).
- `couponRejected: { code, reason }` quando um cupom **manual** submetido é inválido/expirado/
  abaixo do mínimo — o pedido segue inalterado e o front exibe o aviso (ver §3.5).

### 3.5 Validação / erros
- **Cupom/voucher manual inválido/expirado/abaixo do mínimo/CPF/esgotado:** ✅ **não quebra o
  fluxo** — `PATCH /coupon` devolve o pedido **inalterado** + `couponRejected: { code, reason }`
  (HTTP 200), e o front exibe o aviso. (Único erro duro: enviar `couponCode` **e** `voucherCode`
  juntos → `DISCOUNT_CONFLICT`.)
- **Cupom automático (AGE/QUANTITY) que deixa de valer:** ✅ removido silenciosamente, desconto
  vira 0, `couponAutoRemoved: true` na resposta do `PATCH /products`.
- **`PATCH /participants` aceita lista parcial** ✅ (menos participantes que ingressos é ok;
  mais que ingressos → erro). O front pode enviar incrementalmente ao salvar cada participante.
  ✅ **Cupom automático (AGE/QUANTITY) é (re)avaliado e aplicado TAMBÉM no `PATCH /participants`**
  (mesma engine `evaluateAutoCoupons` do `PATCH /products`) — atribuir/editar participante reflete
  na hora no `pricing`, sem depender de uma chamada posterior a `/products`. A sequência
  `/participants` → `/products` é idempotente (reavalia o mesmo cupom; uso só conta no pagamento).

---

## 4. Mudanças no FRONTEND (a fazer após o contrato acima)

1. **`/informacoes` (InformationStep)**
   - Ao **salvar/editar** um participante: `PATCH /orders/:id/participants` com os participantes
     já salvos → no `.then`, `invalidateQueries(["checkout-order", orderId])` para refetch.
   - Remover o cálculo client-side do cupom de idade (`useAgeCouponEligibility` +
     `computeAgeCouponTicketDiscount`) do **resumo**; passar a ler `pricing.couponDiscount`
     (qualquer cupom, incl. idade), `pricing.voucherDiscount`, `pricing.serviceFee`,
     `pricing.total`. Pro rótulo do tipo, ler `coupon.couponType`.
2. **`/produtos` (SubscriptionStep)**
   - Ao mudar variação/produto: `PATCH /orders/:id/products` → refetch da order.
   - Remover `computeCouponDiscount` / taxa / total client-side; ler tudo de `pricing`.
3. **`/ingressos` (ModalitiesStep)**
   - Antes do `reserve` não há order → segue como **prévia** explicitamente client-side
     (não há participantes ainda). Após `reserve`, alinhar com o `pricing` retornado.
4. **`toOrderResponse`** (`useCheckoutReservation.ts`): mapear os novos campos
   (`ticketsSubtotal`, `productsSubtotal`, `couponDiscount`, `voucherDiscount`) e
   expô-los no `OrderResponse.pricing`.
5. **Debounce**: o `PATCH` on-change em `/produtos` deve ter debounce (~400ms) para não
   disparar a cada toque; o de `/informacoes` dispara no **save** (já é discreto).

---

## 5. Aceite (como validar "sem discrepâncias")
- Inscrever 2 participantes, um dentro e outro fora da faixa do cupom de idade → o resumo
  mostra o desconto **só** da unidade elegível, e **muda ao editar** a data de nascimento.
- O valor de `Total` exibido em `/informacoes`, `/produtos` e `/pagamento` é **idêntico**
  (mesma `pricing.total`) e igual ao cobrado.
- Trocar cupom de link e editar participante: cupom manual e idade coexistem corretamente
  (ou o backend define precedência e o front só exibe).
