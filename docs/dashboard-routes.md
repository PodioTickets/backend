# Dashboard API — Integration Guide

> **Base URL:** `https://<api-host>/api/v1`
> **Auth:** Bearer token obrigatório (`Authorization: Bearer <access_token>`)
> **Permissão:** organizador com `dashboard` permission (owner ou membro com permissão explícita)

---

## Visão geral

O endpoint legacy `GET /events/:eventId/dashboard` foi **removido** e dividido em
**3 rotas independentes**, cada uma cobrindo um conjunto coeso de widgets.

| Rota | Conteúdo | Cache backend (Redis) | Cache-Control HTTP |
|---|---|---|---|
| `/dashboard/overview` | KPIs + gráfico de tendência | 30s | `private, max-age=30, stale-while-revalidate=60` |
| `/dashboard/rankings` | Tabelas paginadas (ranking, ingressos, produtos, lotes) | 30s | `private, max-age=30, stale-while-revalidate=60` |
| `/dashboard/secondary` | Widgets secundários (cidades, heatmap, perguntas) | 60s | `private, max-age=60, stale-while-revalidate=120` |

**Implicações pro front:**
- O browser cacheia automaticamente cada rota pelo `max-age`. Mudar página/tab e voltar dentro do TTL → 0 requests pro backend.
- `stale-while-revalidate` libera o browser servir stale enquanto refaz em background — UX instantânea.
- `private` impede CDN/proxy de cachear (dados são por-organizador).
- Para forçar refresh manual (botão "atualizar"), o front deve adicionar um query param burlador (`?_t=Date.now()`) ou usar `fetch(..., { cache: 'reload' })`.

O front deve chamar as 3 rotas **em paralelo** e renderizar cada bloco
independentemente — não há ordem obrigatória, e uma falha em uma rota não
afeta as outras.

**Filtros comuns:** `period` e `ticketIds` aplicam-se às 3 rotas com a mesma
semântica. Recomenda-se enviar os mesmos valores nas 3 chamadas pra coerência
visual.

**Cache backend:** a primeira chamada com um conjunto de params popula o cache
Redis; chamadas subsequentes (dentro do TTL) com os mesmos params retornam
instantaneamente (~5ms). Permission check é executado **sempre**, mesmo em
cache hit.

---

## Filtros comuns (query params)

| Parâmetro | Tipo | Default | Descrição |
|-----------|------|---------|-----------|
| `period` | `geral` \| `24h` \| `7d` \| `15d` \| `1m` \| `2m` | `geral` | Janela temporal. `geral` = sem filtro (todo o histórico do evento). |
| `ticketIds` | `string[]` (UUID) | — | Filtra por inscrições que contêm ao menos um dos tickets. Aceita `ticketIds=a&ticketIds=b` ou `ticketIds[]=a&ticketIds[]=b`. |

---

## 1. Overview — `/dashboard/overview`

```
GET /api/v1/events/:eventId/dashboard/overview
```

Retorna os KPIs principais (above-the-fold) e o gráfico de tendência.

**Query parameters**

Apenas os comuns (`period`, `ticketIds`).

**Response `200`**

```json
{
  "message": "Dashboard overview fetched successfully",
  "data": {
    "period": {
      "selected": "2m",
      "startDate": "2026-03-23T13:14:00.000Z",
      "endDate": "2026-05-23T13:14:00.000Z"
    },
    "metrics": {
      "netRevenue": 1250000,
      "netRevenueChange": 12.5,
      "averageTicket": 12500,
      "averageTicketChange": -3.2,
      "totalRegistrations": 100,
      "totalRegistrationsChange": 15.0,
      "cancellations": 5,
      "cancellationsStatus": "Normal",
      "refunds": 2,
      "refundsStatus": "Normal"
    },
    "registrationsTrend": {
      "amount": 1250000,
      "change": 12.5,
      "confirmed": 100,
      "canceled": 5,
      "refunded": 2,
      "chartData": {
        "labels": ["mar/26", "abr/26", "mai/26"],
        "revenue": [400000, 500000, 350000],
        "dailyData": [
          {
            "date": "2026-03",
            "revenue": 400000,
            "confirmed": 32,
            "canceled": 2,
            "refunded": 0,
            "canceledRevenue": 25000,
            "refundedRevenue": 0
          }
        ]
      }
    }
  }
}
```

**Field reference**

| Campo | Tipo | Unidade | Descrição |
|---|---|---|---|
| `metrics.netRevenue` | number | centavos | Receita líquida do organizador no período (já descontadas as taxas de plataforma e organizador). |
| `metrics.netRevenueChange` | number | % | Variação vs período anterior equivalente. `0` quando period=`geral` (sem comparação). |
| `metrics.averageTicket` | number | centavos | `netRevenue / orderCount`. |
| `metrics.totalRegistrations` | number | — | Inscrições `CONFIRMED + PAID` no período. |
| `metrics.cancellations` | number | — | Inscrições `CANCELLED` no período. |
| `metrics.cancellationsStatus` | `Normal` \| `Atenção` \| `Crítico` | — | Baseado em `cancellations / (paid + cancelled)`: >10% = Crítico, >5% = Atenção. |
| `metrics.refunds` | number | — | Inscrições com pagamento `REFUNDED` no período. |
| `metrics.refundsStatus` | `Normal` \| `Atenção` \| `Crítico` | — | >5% = Crítico, >2% = Atenção. |
| `registrationsTrend.chartData.labels` | string[] | — | Rótulos do eixo X. Para `period=geral` retorna últimos 6 meses (`mar/26`). Para demais períodos retorna dias (`23/mai`). |
| `registrationsTrend.chartData.revenue` | number[] | centavos | Receita líquida por bucket. Alinhado com `labels` e `dailyData`. |
| `registrationsTrend.chartData.dailyData[].date` | string | — | Para período `geral`: `YYYY-MM`. Para diários: `YYYY-MM-DD`. |
| `registrationsTrend.chartData.dailyData[].revenue` | number | centavos | Receita líquida de orders confirmadas no bucket. |
| `registrationsTrend.chartData.dailyData[].canceledRevenue` | number | centavos | Receita potencial perdida em cancelamentos no bucket. |
| `registrationsTrend.chartData.dailyData[].refundedRevenue` | number | centavos | Receita estornada no bucket. |

---

## 2. Rankings — `/dashboard/rankings`

```
GET /api/v1/events/:eventId/dashboard/rankings
```

Tabelas paginadas: ranking de ingressos vendidos, lista de ingressos do evento
(mesmo shape do `/financial`), top variações de produtos e lotes próximos do
esgotamento.

**Query parameters**

| Parâmetro | Tipo | Default | Descrição |
|---|---|---|---|
| `period` | enum | `geral` | (comum) |
| `ticketIds` | string[] | — | (comum) |
| `ticketRankingPage` | number | `1` | Página do bloco `ticketRanking`. |
| `ticketRankingLimit` | number | `10` | Items por página (max `100`). |
| `ticketsPage` | number | `1` | Página do bloco `tickets`. |
| `ticketsLimit` | number | `20` | Items por página (max `100`). |

> Cada bloco tem paginação **independente** — você pode paginar `tickets`
> sem afetar `ticketRanking`.

**Response `200`**

```json
{
  "message": "Dashboard rankings fetched successfully",
  "data": {
    "ticketRanking": {
      "data": [
        {
          "ticketId": "uuid",
          "name": "Pista",
          "category": "Geral",
          "quantity": 42,
          "total": 525000
        }
      ],
      "pagination": { "page": 1, "limit": 10, "total": 8, "totalPages": 1 }
    },
    "tickets": {
      "message": "Tickets fetched successfully",
      "data": {
        "tickets": [ /* ... shape idêntico ao /financial + "organizerNet": 525000 */ ],
        "pagination": { "page": 1, "limit": 20, "total": 12, "totalPages": 1 }
      }
    },
    "topProductVariations": [
      {
        "productId": "uuid",
        "productName": "Camiseta",
        "productImage": "https://...",
        "totalQuantitySold": 30,
        "totalSoldAmount": 90000,
        "variations": [
          {
            "variationId": "uuid",
            "variationName": "P",
            "quantitySold": 10,
            "percentage": 33.33,
            "remainingStock": 5,
            "totalStock": 15
          }
        ]
      }
    ],
    "lotsNearDepletion": [
      {
        "ticketId": "uuid",
        "ticketName": "Pista",
        "status": "Atenção",
        "sold": 80,
        "total": 100,
        "remaining": 20,
        "percentageSold": 80,
        "activeBatch": { "id": "uuid", "number": 2, "label": "Lote 2" },
        "batches": [
          {
            "id": "uuid",
            "name": "Lote 1",
            "total": 50,
            "sold": 50,
            "remaining": 0,
            "percentageSold": 100,
            "status": "Crítico"
          }
        ]
      }
    ]
  }
}
```

**Field reference**

| Campo | Descrição |
|---|---|
| `ticketRanking[].quantity` | Quantidade total de items (tickets) vendidos. Itens de modalidade só contam quando a inscrição não tem ticket. |
| `ticketRanking[].total` | Receita líquida rateada entre todos os items da order (em centavos). |
| `tickets.data.tickets` | Lista de ingressos cadastrados — shape **idêntico** ao retornado por `GET /events/:eventId/financial`, **acrescido** de `organizerNet` (ver abaixo). Inclui inativos (`includeInactive=true`). |
| `tickets.data.tickets[].organizerNet` | **Exclusivo do dashboard.** Líquido do organizador (centavos) que aquele ingresso gerou no período/filtro — quanto ele de fato recebe, já descontadas taxa de plataforma (`serviceFee`) e taxa do organizador (`organizerFeePercent` do pedido), e já considerando cupons e produtos adicionais (parte do `finalAmount`). Rateado por item dentro da order, **mesma fonte de verdade** do `ticketRanking[].total` e do repasse. `0` para ingressos sem venda confirmada/paga no período. |
| `topProductVariations[].totalSoldAmount` | Receita líquida do produto (rateada pela razão `orderNet/orderGross`), em centavos. |
| `topProductVariations[].variations[].remainingStock` | `null` quando o produto tem estoque ilimitado. |
| `topProductVariations[].variations[].variationName` | Pode ser `"Sem variação"` quando há vendas do produto base sem variação selecionada. |
| `lotsNearDepletion[].status` | Agregado do ticket: `Crítico` se ≥90% vendido ou 0 restantes; `Atenção` se ≥75% ou estoque baixo (≤25) + ≥25%. |
| `lotsNearDepletion[].activeBatch` | `null` quando todos os lotes do ticket estão esgotados ou inativos. |

---

## 3. Secondary — `/dashboard/secondary`

```
GET /api/v1/events/:eventId/dashboard/secondary
```

Widgets de menor prioridade (lazy-load recomendado): geolocalização,
distribuição temporal de vendas e respostas de perguntas customizadas.

**Query parameters**

Apenas os comuns (`period`, `ticketIds`).

**Response `200`**

```json
{
  "message": "Dashboard secondary fetched successfully",
  "data": {
    "topCities": [
      { "city": "São Paulo", "state": "SP", "participants": 42 },
      { "city": "Rio de Janeiro", "state": "RJ", "participants": 18 }
    ],
    "salesHeatmap": [
      { "day": "Seg", "hour": 14, "sales": 5 },
      { "day": "Sex", "hour": 19, "sales": 12 }
    ],
    "mostAnsweredQuestions": [
      {
        "questionId": "uuid",
        "question": "Tamanho da camiseta?",
        "order": 1,
        "type": "select",
        "options": ["P", "M", "G"],
        "isRequired": true,
        "participantCount": 50,
        "answersRanking": [
          { "answer": "M", "count": 25, "percentage": 50 },
          { "answer": "G", "count": 15, "percentage": 30 },
          { "answer": "P", "count": 10, "percentage": 20 }
        ]
      }
    ]
  }
}
```

**Field reference**

| Campo | Descrição |
|---|---|
| `topCities` | **Máximo 2 cidades** (cap fixo no backend). Conta `participants` = 1 por registration paga+confirmada. Participantes sem conta de usuário não entram. |
| `topCities[].city` / `state` | Casing original do cadastro do usuário. Backend faz dedupe normalizado (`"São Paulo"` ≡ `"sao paulo"` ≡ `"SAO PAULO"`), mas exibe o casing da primeira ocorrência. |
| `topCities[].state` | **Pode estar ausente** quando o estado do usuário é `null`/`""`. Front deve tratar `{city, participants}` como shape válido. |
| `salesHeatmap[].day` | Abreviado em PT-BR: `Dom`, `Seg`, `Ter`, `Qua`, `Qui`, `Sex`, `Sab`. |
| `salesHeatmap[].hour` | 0-23, fuso do servidor (BRT). Use pra montar grid 7×24. Buckets sem vendas **não aparecem** — trate ausência como 0. |
| `mostAnsweredQuestions[].type` | Tipo da pergunta: `text` \| `select` \| `checkbox` \| `true_false`. Pra `true_false`, `answersRanking[].answer` é `"Verdadeiro"` ou `"Falso"`. |
| `mostAnsweredQuestions[].answersRanking[].percentage` | % sobre `participantCount` (não sobre `count` total — respostas de checkbox podem somar >100%). |

---

## Padrões de resposta

### Strip de campos vazios

O `ResponseCompressionInterceptor` global **remove** qualquer chave com valor
`null`, `undefined` ou `""` do response. Implicações práticas:

- `topCities[].state` pode estar ausente quando o usuário não tem estado cadastrado.
- `topProductVariations[].productImage` pode estar ausente quando o produto não tem imagem.
- `topProductVariations[].variations[].remainingStock` / `totalStock` podem estar ausentes (estoque ilimitado).

Sempre trate ausência como equivalente a `null` no consumo.

### Erros

| Status | Causa | Body |
|---|---|---|
| `400` | `period` inválido, `ticketsLimit` > 100, UUID malformado | `{ "statusCode": 400, "message": "Falha na validação" }` |
| `401` | Token ausente ou inválido | `{ "statusCode": 401, "message": "Unauthorized" }` |
| `403` | Usuário não é organizador do evento ou sem permissão `dashboard` | `{ "statusCode": 403, "message": "..." }` |
| `404` | Evento não existe | `{ "statusCode": 404, "message": "..." }` |

---

## Migração do endpoint legacy

A rota `GET /events/:eventId/dashboard` (resposta única) foi **removida**.
Mapeamento dos campos:

| Campo legacy | Rota nova | Caminho novo |
|---|---|---|
| `data.period` | `/overview` | `data.period` |
| `data.metrics` | `/overview` | `data.metrics` |
| `data.registrationsTrend` | `/overview` | `data.registrationsTrend` |
| `data.ticketRanking` | `/rankings` | `data.ticketRanking` |
| `data.tickets` | `/rankings` | `data.tickets` |
| `data.topProductVariations` | `/rankings` | `data.topProductVariations` |
| `data.lotsNearDepletion` | `/rankings` | `data.lotsNearDepletion` |
| `data.topCities` | `/secondary` | `data.topCities` |
| `data.salesHeatmap` | `/secondary` | `data.salesHeatmap` |
| `data.mostAnsweredQuestions` | `/secondary` | `data.mostAnsweredQuestions` |

### Breaking changes além do split

1. **`topCities[].buyers` → `topCities[].participants`** — renomeado.
   Semântica é a mesma (1 por registration paga + confirmada).
2. **`chartData.monthlyData` removido** — era um campo legacy que espelhava
   `dailyData`. Use `chartData.dailyData` para qualquer período. Para
   `period=geral`, `dailyData[].date` agora é `YYYY-MM` em vez de `YYYY-MM-DD`.
3. **Paginação do `ticketRanking`**: o param antes era `page`/`limit` (raiz).
   Agora é `ticketRankingPage`/`ticketRankingLimit`.

### Exemplo de chamada paralela (axios)

```ts
const [overview, rankings, secondary] = await Promise.all([
  api.get(`/events/${eventId}/dashboard/overview`, { params: { period, ticketIds } }),
  api.get(`/events/${eventId}/dashboard/rankings`, {
    params: { period, ticketIds, ticketRankingPage, ticketRankingLimit, ticketsPage, ticketsLimit },
  }),
  api.get(`/events/${eventId}/dashboard/secondary`, { params: { period, ticketIds } }),
]);
```

---

## Notas de performance

- O backend agora usa **agregação SQL** (raw queries via `$queryRaw`) em vez
  de carregar todas as registrations em memória. Custo de query: O(rows)
  no Postgres, sem trafegar dados pra Node.
- **Cache Redis fail-open**: se o Redis estiver indisponível, as queries
  rodam normalmente. Front não precisa tratar essa situação.
- A chave de cache inclui um hash dos params — paginar muda a chave, o que
  é desejado (cada página é cacheada separadamente).
- **Bypass de cache (backend Redis)**: não existe header pra forçar fresh.
  Se precisar, espere o TTL passar (30-60s). Em desenvolvimento, considere
  reiniciar o Redis pra limpar.
- **Bypass de cache (browser HTTP)**: adicione query param dinâmico
  (`?_=${Date.now()}`) ou use `fetch(..., { cache: 'reload' })` /
  `axios({ headers: { 'Cache-Control': 'no-cache' } })`.
