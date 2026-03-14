# API do Dashboard do Evento

## Visão geral

O endpoint do dashboard retorna métricas, tendências, rankings e dados de insights do evento. Acesso restrito ao organizador (membro da organização do evento).

---

## Endpoint: obter dados do dashboard

**Método**: `GET`  
**URL**: `/api/v1/events/:eventId/dashboard`

**Autenticação**: Bearer JWT (organizador).

**Parâmetros de path**:
- `eventId` (obrigatório): UUID do evento.

**Query params** (opcionais):
- `period`: Período dos dados. Valores: `geral`, `24h`, `7d`, `15d`, `1m`, `2m`. Default: `geral`.
- `ticketIds`: Array de UUIDs de ingressos para filtrar (ex.: `ticketIds[]=uuid1&ticketIds[]=uuid2`).
- `page`: Página do ranking de ingressos (default: 1).
- `limit`: Itens por página no ranking (default: 10).

**Exemplo de requisição**:
```bash
curl -X GET "https://api.exemplo.com/api/v1/events/SEU-EVENT-ID/dashboard?period=7d" \
  -H "Authorization: Bearer SEU_JWT"
```

**Respostas**:
- `200`: Dados do dashboard.
- `401`: Não autenticado.
- `403`: Sem permissão (não é organizador do evento).
- `404`: Evento não encontrado.

---

## Estrutura da resposta (200)

O corpo da resposta segue o formato:

```json
{
  "message": "Dashboard data fetched successfully",
  "data": {
    "period": { "selected": "geral", "startDate": null, "endDate": null },
    "metrics": { ... },
    "registrationsTrend": { ... },
    "ticketRanking": { ... },
    "topCities": [ ... ],
    "lotsNearDepletion": [ ... ],
    "salesHeatmap": { ... },
    "topProductVariations": [ ... ],
    "mostAnsweredQuestions": [ ... ]
  }
}
```

As seções **topProductVariations** e **mostAnsweredQuestions** são descritas abaixo.

---

## topProductVariations — Variações mais vendidas por produto

Lista, para cada produto do evento que teve venda, a **imagem do produto**, as variações ordenadas pela quantidade vendida (maior primeiro) e, por variação: **% de venda** (em relação ao total do produto), **quantidade vendida**, **estoque restante** e **estoque total** (que havia). Considera apenas **inscrições confirmadas e com pagamento pago**.

**Tipo**: array de objetos.

**Estrutura de cada item (produto)**:

| Campo          | Tipo   | Descrição |
|----------------|--------|-----------|
| `productId`    | string | UUID do produto |
| `productName`  | string | Nome do produto |
| `productImage` | string \| null | URL ou caminho da imagem do produto; `null` se não houver |
| `variations`   | array  | Variações ordenadas por quantidade vendida (maior primeiro) |

**Cada elemento de `variations`**:

| Campo            | Tipo   | Descrição |
|------------------|--------|-----------|
| `variationId`    | string \| null | UUID da variação ou `null` (ex.: "Sem variação") |
| `variationName`  | string | Nome da variação (ex.: "M", "G", "Sem variação") |
| `quantitySold`   | number | Quantidade vendida dessa variação |
| `percentage`     | number | Porcentagem das vendas do produto que foram dessa variação (0–100, 2 decimais) |
| `remainingStock` | number \| null | Estoque restante da variação; `null` se ilimitado ou "Sem variação" |
| `totalStock`     | number \| null | Estoque total que havia (restante + vendido); `null` se ilimitado ou "Sem variação" |

Quando o estoque da variação é ilimitado (0 no cadastro), `remainingStock` e `totalStock` vêm `null`.

**Exemplo**:
```json
"topProductVariations": [
  {
    "productId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "productName": "Camiseta",
    "productImage": "/uploads/images/camiseta.jpg",
    "variations": [
      {
        "variationId": "v-uuid-m",
        "variationName": "M",
        "quantitySold": 45,
        "percentage": 50.56,
        "remainingStock": 5,
        "totalStock": 50
      },
      {
        "variationId": "v-uuid-g",
        "variationName": "G",
        "quantitySold": 30,
        "percentage": 33.71,
        "remainingStock": 0,
        "totalStock": 30
      },
      {
        "variationId": "v-uuid-p",
        "variationName": "P",
        "quantitySold": 12,
        "percentage": 13.48,
        "remainingStock": null,
        "totalStock": null
      },
      {
        "variationId": null,
        "variationName": "Sem variação",
        "quantitySold": 2,
        "percentage": 2.25,
        "remainingStock": null,
        "totalStock": null
      }
    ]
  }
]
```

Quando não há vendas de produtos no período (ou em inscrições pagas/confirmadas), o array vem vazio: `"topProductVariations": []`.

---

## mostAnsweredQuestions — Perguntas mais respondidas

Lista as perguntas do evento que possuem pelo menos uma resposta, ordenadas pela **quantidade de participantes que responderam** (maior primeiro). Para cada pergunta são retornados: tipo, opções (quando aplicável), quantidade de participantes que responderam, e um **ranking de respostas** com a quantidade e a **porcentagem** de cada valor respondido.

**Tipo**: array de objetos.

**Estrutura de cada item**:

| Campo             | Tipo   | Descrição |
|-------------------|--------|-----------|
| `questionId`      | string | UUID da pergunta |
| `question`        | string | Texto da pergunta |
| `order`           | number | Ordem da pergunta no evento |
| `type`            | string | Tipo da pergunta: `text`, `select`, `radio`, `checkbox` |
| `options`         | object \| null | Opções (para select/radio/checkbox); formato definido no cadastro da pergunta |
| `isRequired`      | boolean | Se a pergunta é obrigatória |
| `participantCount`| number | Quantidade de participantes que responderam a esta pergunta |
| `answersRanking`  | array  | Ranking das respostas (mais escolhidas primeiro); cada item: `answer`, `count`, `percentage` |

**Estrutura de cada item em `answersRanking`**:

| Campo       | Tipo   | Descrição |
|-------------|--------|-----------|
| `answer`    | string | Valor respondido (texto livre ou opção escolhida) |
| `count`     | number | Quantidade de vezes que essa resposta foi dada |
| `percentage`| number | Porcentagem em relação ao total de respostas da pergunta (0–100, com até 2 casas decimais) |

Respostas em branco são agrupadas como `"(vazio)"`.

**Exemplo**:
```json
"mostAnsweredQuestions": [
  {
    "questionId": "q-uuid-1",
    "question": "Tamanho da camiseta?",
    "order": 1,
    "type": "radio",
    "options": ["P", "M", "G", "GG"],
    "isRequired": true,
    "participantCount": 120,
    "answersRanking": [
      { "answer": "M", "count": 52, "percentage": 43.33 },
      { "answer": "G", "count": 38, "percentage": 31.67 },
      { "answer": "P", "count": 18, "percentage": 15 },
      { "answer": "GG", "count": 12, "percentage": 10 }
    ]
  },
  {
    "questionId": "q-uuid-2",
    "question": "Possui restrição alimentar?",
    "order": 2,
    "type": "text",
    "options": null,
    "isRequired": false,
    "participantCount": 98,
    "answersRanking": [
      { "answer": "Não", "count": 85, "percentage": 86.73 },
      { "answer": "Sim, lactose", "count": 8, "percentage": 8.16 },
      { "answer": "(vazio)", "count": 5, "percentage": 5.1 }
    ]
  }
]
```

Quando não há respostas em nenhuma pergunta do evento, o array vem vazio: `"mostAnsweredQuestions": []`.

---

## Observações

- **Período e filtros**: Os query params `period` e `ticketIds` afetam métricas, rankings e gráficos do dashboard. **topProductVariations** e **mostAnsweredQuestions** são calculados com base em **todas** as inscrições do evento (confirmadas e pagas para variações; todas as respostas para perguntas), não apenas do período ou dos tickets filtrados.
- **Uso no front**: Use `topProductVariations` para relatórios de produtos/variações mais vendidas e `mostAnsweredQuestions` para destacar perguntas com maior taxa de resposta no dashboard do organizador.
