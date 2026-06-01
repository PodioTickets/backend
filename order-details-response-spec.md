# Contrato — `GET /api/v1/orders/:id/details`

Resposta consumida por **duas** telas do frontend (mesmo payload):

- **Pagamento concluído** — `src/app/checkout/sucesso/page.tsx`
- **Detalhe do ingresso do usuário** — `src/app/user/tickets/[id]/page.tsx`

> Objetivo deste doc: padronizar o payload pra o front exibir **valores corretos por
> ingresso e por produto sem precisar "diluir" o subtotal** (causa do bug atual: produto de
> R$10 comprado em UM ingresso aparecia como R$5 + R$5 nos dois).

---

## 0. Glossário (o que é cada coisa)

| Termo | Definição |
|---|---|
| **Order** | O pedido inteiro (1 compra). Tem 1 pricing agregado e N registrations. |
| **Registration** | UMA inscrição = UM participante em UM ingresso. É a unidade da lista. Se o comprador levou 2 ingressos, há 2 registrations. |
| **Ticket** | O ingresso (modalidade/lote) daquela registration. Tem nome, categoria e **preço próprio**. |
| **Produto adicional (opcional)** | Item pago à parte (ex.: camiseta R$10), vinculado a UMA registration específica. NÃO é diluído entre ingressos. |
| **Produto incluso** | Produto que já vem no ingresso (grátis). Aparece como "Incluso", não soma. |
| **Variação "Sem interesse"** | Opt-out de um produto opcional. NÃO deve aparecer em lugar nenhum nem somar nada. |

**Regra de ouro:** todo valor monetário é **inteiro em CENTAVOS** (ex.: `10000` = R$100,00).
Nunca enviar float em reais.

---

## 1. Estrutura geral

```jsonc
{
  "data": {                 // o front lê `response.data.data` (ou `.data`)
    "order":   { ... },     // §2 — meta + pricing AGREGADO do pedido
    "payment": { ... },     // §3 — forma/!data do pagamento
    "event":   { ... },     // §4 — dados do evento (cabeçalho)
    "registrations": [ ... ] // §5 — UMA entrada por participante/ingresso
  }
}
```

---

## 2. `order` — pedido + pricing agregado

```jsonc
{
  "id": "PT-2026-000123",          // número do pedido exibido (#id)
  "createdAt": "2026-06-01T12:34:56.000Z",
  "coupon":  { "code": "ALUNO10", "couponType": "DISCOUNT", "type": "PERCENTAGE", "value": 10 } | null,
  "voucher": { "code": "VIP-AB12" } | null,   // cupom e voucher são EXCLUSIVOS
  "pricing": {
    "ticketsSubtotal": 20000,   // (NOVO/garantir) soma SÓ dos ingressos, centavos
    "productsSubtotal": 1000,   // soma SÓ dos produtos adicionais pagos, centavos
    "subtotal": 21000,          // ticketsSubtotal + productsSubtotal
    "serviceFee": 0,            // taxa de serviço, centavos
    "couponDiscount": 0,        // desconto de cupom, centavos (0 se voucher)
    "voucherDiscount": 0,       // desconto de voucher, centavos (0 se cupom)
    "discount": 0,              // legado: desconto aplicado (cupom OU voucher)
    "total": 21000             // valor final pago, centavos
  }
}
```

### Pontos críticos do pricing
- **`ticketsSubtotal` e `productsSubtotal` SEPARADOS são obrigatórios.** Hoje o front recebe só
  `subtotal` agregado e tenta inferir o preço do ingresso dividindo pelo nº de inscrições — o que
  **dilui** o produto entre os ingressos (bug). Com os dois campos, o front nunca mais divide.
- `subtotal == ticketsSubtotal + productsSubtotal` (antes de descontos).
- Cupom e voucher são mutuamente exclusivos: preencher **um** dos `couponDiscount`/`voucherDiscount`.

---

## 3. `payment`

```jsonc
{
  "method": "CREDIT_CARD",   // CREDIT_CARD | DEBIT_CARD | PIX | BOLETO
  "paymentDate": "2026-06-01T12:35:10.000Z"
}
```

---

## 4. `event`

```jsonc
{
  "id": "evt_123",
  "name": "Corrida XYZ 2026",
  "eventDate": "2026-07-20T00:00:00.000Z",
  "bannerUrl": "https://cdn.../banner.png",
  "city": "São Paulo",
  "state": "SP"
}
```

---

## 5. `registrations[]` — UMA por participante/ingresso  ⭐ (núcleo da correção)

Cada item = 1 participante em 1 ingresso. **É aqui que o preço por ingresso e os produtos
daquele ingresso precisam vir explícitos** (sem agregação no nível do pedido).

```jsonc
{
  "id": "reg_abc",
  "qrCode": "https://.../validate/reg_abc",   // ou string crua do QR

  // ---- TICKET (o ingresso desta registration) ----
  "ticket": {
    "name": "Ingresso Avulso",                // nome exibido
    "category": { "name": "Lote 1" } | null,  // categoria; null/ausente => "Ingresso avulso"
    "unitPrice": 10000,    // ⭐ PREÇO DO INGRESSO (centavos) — SÓ o ingresso, SEM produtos
    "distance": 5,                            // opcional (corrida)
    "distanceUnit": "km",                     // opcional

    // catálogo de produtos JÁ INCLUSOS no ingresso (grátis) — ver §6
    "includedProducts": [ ... ]
  },

  // ---- PARTICIPANTE ----
  "participant": {
    "fullName": "Maria Silva",                // ou firstName/lastName
    "email": "maria@x.com",
    "documentType": "CPF",                    // CPF | PASSPORT | null
    "documentNumber": "12345678901",
    "country": "Brasil",                      // decide CPF vs documento estrangeiro
    "dateOfBirth": "1990-05-01",
    "gender": "FEMALE",                       // MALE|FEMALE|OTHER|PREFER_NOT_TO_SAY|null
    "phone": "11999990000",
    "avatarUrl": ""
  },

  "emergencyContact": { "name": "João", "phone": "11988887777" } | null,
  "questionAnswers": [ { "id": "...", "question": { "question": "..." }, "answer": "..." } ],

  // ---- PRODUTOS ADICIONAIS PAGOS (carrinho) desta registration ----
  "products": [ ... ]   // ver §6
}
```

### ⭐ `ticket.unitPrice` é o campo que falta hoje
- DEVE ser o preço **só do ingresso** (sem produtos), em centavos.
- Permite ingressos de **valores diferentes** no mesmo pedido (ex.: um R$100 e outro R$80) —
  hoje impossível, porque o front divide o subtotal igualmente.
- Invariante: `Σ(registrations[].ticket.unitPrice) == pricing.ticketsSubtotal`.

---

## 6. Produtos — `products[]` (pagos) e `ticket.includedProducts[]` (grátis)

### 6.1 `products[]` — adicionais PAGOS, atrelados a ESTA registration
```jsonc
{
  "product": {
    "id": "prod_1",
    "name": "Camiseta",
    "image": "https://cdn.../camiseta.png",
    "variationType": "Tamanho"
  },
  "variation": { "id": "var_M", "name": "M", "price": 1000 },  // centavos
  "quantity": 1,
  "unitPrice": 1000,    // centavos — preço unitário cobrado
  "totalPrice": 1000    // centavos — unitPrice * quantity
}
```

**Regras:**
- Cada produto pago pertence a **UMA** registration (a que o comprou). NUNCA distribuir entre
  ingressos. No exemplo do bug: a camiseta de R$10 vai **só** na registration que a comprou; a
  outra registration tem `products: []`.
- Invariante: `Σ(todos products[].totalPrice) == pricing.productsSubtotal`.
- **"Sem interesse"** (opt-out): **não enviar** esses itens em `products[]` (nem com price 0). O
  front filtra por nome, mas o ideal é o backend já omitir.

### 6.2 `ticket.includedProducts[]` — INCLUSOS no ingresso (grátis)
```jsonc
{
  "id": "prod_2",
  "name": "Squeeze",
  "basePrice": 0,                  // centavos; exibido como "Incluso"
  "isIncludedInTicket": true,
  "variationType": "Cor",
  "selectedVariation": { "name": "Azul" } | null,
  "isRequired": true,
  "image": "https://cdn.../squeeze.png"
}
```

**Regras:**
- Só itens com `isIncludedInTicket: true`.
- Se um produto incluso também foi comprado como opcional (aparece em `products[]`), **não
  duplicar**: o front esconde o incluso quando o mesmo `product.id` está no carrinho — então
  prefira mandar nos dois lugares de forma consistente (ou só no `products[]` quando pago).
- "Sem interesse" em incluso: omitir.

---

## 7. Exemplo completo (o cenário do bug, CORRETO)

2 ingressos de R$100 + 1 camiseta de R$10 comprada **no primeiro** ingresso.

```jsonc
{
  "data": {
    "order": {
      "id": "PT-2026-000123",
      "createdAt": "2026-06-01T12:34:56.000Z",
      "coupon": null, "voucher": null,
      "pricing": {
        "ticketsSubtotal": 20000,   // 100 + 100
        "productsSubtotal": 1000,   // 10
        "subtotal": 21000,
        "serviceFee": 0,
        "couponDiscount": 0, "voucherDiscount": 0, "discount": 0,
        "total": 21000
      }
    },
    "payment": { "method": "PIX", "paymentDate": "2026-06-01T12:35:10.000Z" },
    "event": { "id": "evt_1", "name": "Corrida XYZ", "eventDate": "2026-07-20T00:00:00.000Z",
               "bannerUrl": "https://cdn/b.png", "city": "São Paulo", "state": "SP" },
    "registrations": [
      {
        "id": "reg_1",
        "ticket": { "name": "Ingresso Avulso", "category": null, "unitPrice": 10000, "includedProducts": [] },
        "participant": { "fullName": "Maria", "email": "m@x.com", "documentType": "CPF",
                          "documentNumber": "12345678901", "country": "Brasil",
                          "dateOfBirth": "1990-05-01", "gender": "FEMALE", "phone": "11999990000" },
        "products": [
          { "product": { "id": "p_cam", "name": "Camiseta", "image": "https://cdn/c.png", "variationType": "Tamanho" },
            "variation": { "id": "v_M", "name": "M", "price": 1000 },
            "quantity": 1, "unitPrice": 1000, "totalPrice": 1000 }
        ]
      },
      {
        "id": "reg_2",
        "ticket": { "name": "Ingresso Avulso", "category": null, "unitPrice": 10000, "includedProducts": [] },
        "participant": { "fullName": "João", "email": "j@x.com", "documentType": "CPF",
                          "documentNumber": "98765432100", "country": "Brasil",
                          "dateOfBirth": "1992-03-10", "gender": "MALE", "phone": "11988887777" },
        "products": []     // ⭐ sem produto — não herda a camiseta do reg_1
      }
    ]
  }
}
```

### Como o front renderiza com esse payload (correto)
```
Produtos adicionais:           R$ 10,00      <- pricing.productsSubtotal

Ingresso Avulso                R$ 100,00     <- reg_1.ticket.unitPrice
Ingresso Avulso                R$ 100,00     <- reg_2.ticket.unitPrice
Subtotal:                      R$ 210,00     <- pricing.subtotal
```
(Hoje, sem `unitPrice`/`productsSubtotal` confiáveis, sai R$105 + R$105 — errado.)

---

## 8. Checklist pro backend

- [ ] `pricing.ticketsSubtotal` e `pricing.productsSubtotal` **separados** (centavos).
- [ ] `registrations[].ticket.unitPrice` = preço do ingresso, **sem** produtos (centavos).
- [ ] `registrations[].products[]` = produtos pagos **só** da registration que os comprou
      (`unitPrice`, `totalPrice`, `quantity`, `variation`).
- [ ] Variação **"Sem interesse" omitida** de `products` e `includedProducts`.
- [ ] Produto pago que também é incluso: não duplicar (mandar como pago, não como incluso).
- [ ] Invariantes: `Σ ticket.unitPrice == ticketsSubtotal`; `Σ products.totalPrice == productsSubtotal`;
      `subtotal == ticketsSubtotal + productsSubtotal`.
- [ ] Todos os valores em **centavos inteiros**.

---

## 9. Compatibilidade / migração no front

Quando o backend passar a enviar os campos acima, o front:
1. Usa `reg.ticket.unitPrice` direto (em vez de `subtotal / nº inscrições`).
2. Usa `pricing.productsSubtotal` na linha "Produtos adicionais".
3. Remove a heurística de diluição nas duas telas (`/checkout/sucesso` e `/user/tickets/[id]`).

Enquanto a migração não acontece, o front mantém o fallback atual (diluição) — por isso os campos
novos são **aditivos** (não quebram o payload existente).
```
