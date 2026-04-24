# GET /api/v1/tickets/events/:eventId

Lista todos os ingressos ativos de um evento com capacidade, vagas disponíveis e produtos vinculados.

---

## Request

```
GET /api/v1/tickets/events/{eventId}?page=1&limit=20
```

**Autenticação:** não obrigatória (rota pública)

### Path Parameters

| Parâmetro | Tipo   | Obrigatório | Descrição      |
|-----------|--------|-------------|----------------|
| `eventId` | UUID   | sim         | ID do evento   |

### Query Parameters

| Parâmetro    | Tipo    | Padrão | Descrição                              |
|--------------|---------|--------|----------------------------------------|
| `page`       | integer | `1`    | Número da página                       |
| `limit`      | integer | `20`   | Itens por página (máx. recomendado: 500) |
| `categoryId` | UUID    | —      | Filtra ingressos de uma categoria específica |

---

## Response `200 OK`

```jsonc
{
  "message": "Tickets fetched successfully",
  "data": {
    "tickets": [ /* Ticket[] — ver abaixo */ ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 4,
      "totalPages": 1
    }
  }
}
```

---

## Objeto `Ticket`

```jsonc
{
  // ── Identidade ─────────────────────────────────────────────────────────
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "eventId": "999ef0df-a1a3-4e10-95eb-7b2b8df6f0c7",
  "name": "Corrida 5KM",
  "description": "Ingresso para corrida de 5KM",
  "modality": "Corrida de rua",
  "distance": "5",
  "distanceUnit": "KM",        // "KM" | "M" | "MI"
  "gender": "all",             // "all" | "male" | "female"
  "sortOrder": 0,
  "isActive": true,

  // ── Capacidade (nível do ticket — soma de todos os lotes) ──────────────
  "totalQuantity": 200,        // capacidade total (soma de batch.quantity)
  "availableQuantity": 143,    // vagas restantes (soma de batch.availableQuantity)
  "quantitySold": 57,          // inscrições existentes (soma de batch.quantitySold)
  "isSoldOut": false,          // true quando availableQuantity === 0

  // ── Preço de referência ────────────────────────────────────────────────
  "price": 15000,              // preço do primeiro lote, em centavos (R$ 150,00)

  // ── Limite de idade ────────────────────────────────────────────────────
  "ageLimit": {
    "min": 16,                 // null se sem restrição mínima
    "max": null                // null se sem restrição máxima
  },
  "ageLimitMin": 16,           // campo bruto (use ageLimit.min)
  "ageLimitMax": null,

  // ── Kit ───────────────────────────────────────────────────────────────
  "hasKit": true,
  "kitId": "uuid-do-kit",      // null se hasKit=false
  "kit": {                     // null se hasKit=false
    "id": "uuid",
    "name": "Kit 5KM",
    "items": [
      { "id": "uuid", "name": "Camiseta", "quantity": 1 }
    ]
  },

  // ── Categoria ─────────────────────────────────────────────────────────
  "categoryId": "uuid-da-categoria",  // null se sem categoria
  "category": {                        // null se sem categoria
    "id": "uuid",
    "name": "Feminino"
  },

  // ── Lotes ─────────────────────────────────────────────────────────────
  "batches": [ /* TicketBatch[] — ver abaixo */ ],

  // ── Produtos vinculados ────────────────────────────────────────────────
  "productIds": ["uuid-produto-1"],   // atalho com apenas os IDs
  "products": [ /* TicketProduct[] — ver abaixo */ ],

  "createdAt": "2025-01-10T12:00:00.000Z",
  "updatedAt": "2025-04-13T08:30:00.000Z"
}
```

---

## Objeto `TicketBatch`

```jsonc
{
  "id": "b1c2d3e4-...",
  "ticketId": "3fa85f64-...",

  // ── Capacidade do lote ─────────────────────────────────────────────────
  "quantity": 100,             // capacidade total do lote
  "availableQuantity": 72,     // vagas restantes (counter atômico do banco)
  "remainingQuantity": 72,     // alias de availableQuantity (mesmo valor)
  "quantitySold": 28,          // inscrições vinculadas a este lote

  // ── Preço ─────────────────────────────────────────────────────────────
  "price": 15000,              // em centavos — R$ 150,00

  // ── Vigência ──────────────────────────────────────────────────────────
  "startDate": "2025-03-01T00:00:00.000Z",  // null = sem data de início
  "endDate": "2025-05-31T23:59:59.000Z",    // null = sem data de fim

  "createdAt": "2025-01-10T12:00:00.000Z",
  "updatedAt": "2025-04-13T08:30:00.000Z"
}
```

> **Lote ativo:** o lote está disponível para compra quando `startDate <= agora <= endDate`
> (campos nulos ignorados) **e** `availableQuantity > 0`.

---

## Objeto `TicketProduct`

```jsonc
{
  "id": "tp-uuid",
  "ticketId": "3fa85f64-...",
  "productId": "uuid-produto-1",
  "sortOrder": 0,
  "product": {
    "id": "uuid-produto-1",
    "name": "Camiseta",
    "image": "https://cdn.exemplo.com/camiseta.jpg",   // null se sem imagem principal
    "images": [
      "https://cdn.exemplo.com/camiseta-1.jpg",
      "https://cdn.exemplo.com/camiseta-2.jpg"
    ],
    "primaryImageIndex": 0,
    "isIncludedInTicket": true,   // true = produto incluso sem custo adicional
    "basePrice": 0,               // em centavos; ignorado se isIncludedInTicket=true
    "isRequired": false,          // true = participante obrigado a selecionar
    "variationType": "Tamanhos",  // null se sem variações
    "buyerVariationEditAllowed": true,
    "variationEditDeadlineDays": 7,
    "variations": [
      {
        "id": "var-uuid",
        "productId": "uuid-produto-1",
        "name": "P",
        "price": 0,    // em centavos
        "stock": 50    // 0 = ilimitado
      }
    ]
  }
}
```

---

## Exemplo completo

**Request**
```
GET /api/v1/tickets/events/999ef0df-a1a3-4e10-95eb-7b2b8df6f0c7?page=1&limit=500
```

**Response**
```json
{
  "message": "Tickets fetched successfully",
  "data": {
    "tickets": [
      {
        "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        "eventId": "999ef0df-a1a3-4e10-95eb-7b2b8df6f0c7",
        "name": "Corrida 5KM",
        "description": null,
        "modality": "Corrida de rua",
        "distance": "5",
        "distanceUnit": "KM",
        "gender": "all",
        "sortOrder": 0,
        "isActive": true,
        "totalQuantity": 200,
        "availableQuantity": 143,
        "quantitySold": 57,
        "isSoldOut": false,
        "price": 15000,
        "ageLimit": { "min": null, "max": null },
        "ageLimitMin": null,
        "ageLimitMax": null,
        "hasKit": false,
        "kitId": null,
        "kit": null,
        "categoryId": null,
        "category": null,
        "batches": [
          {
            "id": "b1c2d3e4-0000-0000-0000-000000000001",
            "ticketId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            "quantity": 100,
            "availableQuantity": 72,
            "remainingQuantity": 72,
            "quantitySold": 28,
            "price": 12000,
            "startDate": null,
            "endDate": "2025-04-30T23:59:59.000Z",
            "createdAt": "2025-01-10T12:00:00.000Z",
            "updatedAt": "2025-04-13T08:30:00.000Z"
          },
          {
            "id": "b1c2d3e4-0000-0000-0000-000000000002",
            "ticketId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            "quantity": 100,
            "availableQuantity": 71,
            "remainingQuantity": 71,
            "quantitySold": 29,
            "price": 15000,
            "startDate": "2025-05-01T00:00:00.000Z",
            "endDate": null,
            "createdAt": "2025-01-10T12:00:00.000Z",
            "updatedAt": "2025-04-13T08:30:00.000Z"
          }
        ],
        "productIds": ["uuid-produto-1"],
        "products": [
          {
            "id": "tp-uuid",
            "ticketId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            "productId": "uuid-produto-1",
            "sortOrder": 0,
            "product": {
              "id": "uuid-produto-1",
              "name": "Camiseta",
              "image": null,
              "images": [],
              "primaryImageIndex": 0,
              "isIncludedInTicket": false,
              "basePrice": 0,
              "isRequired": false,
              "variationType": "Tamanhos",
              "buyerVariationEditAllowed": false,
              "variationEditDeadlineDays": 0,
              "variations": [
                { "id": "v1", "productId": "uuid-produto-1", "name": "P", "price": 3000, "stock": 0 },
                { "id": "v2", "productId": "uuid-produto-1", "name": "M", "price": 3000, "stock": 0 },
                { "id": "v3", "productId": "uuid-produto-1", "name": "G", "price": 3000, "stock": 0 }
              ]
            }
          }
        ],
        "createdAt": "2025-01-10T12:00:00.000Z",
        "updatedAt": "2025-04-13T08:30:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 500,
      "total": 1,
      "totalPages": 1
    }
  }
}
```

---

## Campos de capacidade — resumo rápido

| Campo                      | Onde  | O que representa                                        |
|----------------------------|-------|---------------------------------------------------------|
| `ticket.totalQuantity`     | ticket | Soma de `batch.quantity` de todos os lotes             |
| `ticket.availableQuantity` | ticket | Soma de `batch.availableQuantity` — **vagas restantes** |
| `ticket.quantitySold`      | ticket | Soma de `batch.quantitySold`                           |
| `ticket.isSoldOut`         | ticket | `true` quando `availableQuantity === 0`                |
| `batch.quantity`           | lote   | Capacidade total daquele lote                          |
| `batch.availableQuantity`  | lote   | Vagas restantes do lote (counter atômico)              |
| `batch.remainingQuantity`  | lote   | Alias de `availableQuantity`                           |
| `batch.quantitySold`       | lote   | Inscrições vinculadas ao lote                          |

> **Importante:** `availableQuantity` é o counter atômico decrementado no momento da reserva.
> É a fonte de verdade para exibir disponibilidade no frontend. Não recalcule com base em `quantitySold`.

---

## Notas de implementação

- Preços estão sempre em **centavos** (integer). Divida por `100` para exibir em reais.
- Lotes são retornados ordenados por `price asc`. O lote ativo no momento é o que tem `startDate <= now <= endDate` com `availableQuantity > 0`.
- Ingressos são ordenados por `sortOrder asc, createdAt asc`.
- A rota retorna apenas ingressos com `isActive = true`.
- Sem cache — use `@NoCache()`. Sempre reflete o estado atual do banco.
