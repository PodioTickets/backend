# Dashboard — `topProductVariations` (atualização)

## Endpoint

```
GET /api/v1/events/:eventId/dashboard
```

### Query params

| Param       | Tipo     | Obrigatório | Valores aceitos                          | Default  |
|-------------|----------|-------------|------------------------------------------|----------|
| `period`    | string   | não         | `geral`, `24h`, `7d`, `15d`, `1m`, `2m` | `geral`  |
| `ticketIds` | string[] | não         | UUIDs dos ingressos                      | —        |
| `page`      | number   | não         | inteiro ≥ 1                              | `1`      |
| `limit`     | number   | não         | inteiro 1–100                            | `10`     |

---

## Campo `topProductVariations`

Retorna os **produtos mais vendidos** do evento, ordenados por **quantidade total de unidades vendidas (maior → menor)**. Considera apenas inscrições com status `confirmed` e pagamento `paid`.

### Tipo TypeScript

```ts
type TopProductVariation = {
  productId: string;
  productName: string;
  productImage: string | null;
  totalQuantitySold: number;   // NOVO — total de unidades vendidas no produto
  totalSoldAmount: number;     // receita total em centavos
  variations: {
    variationId: string | null; // null = produto sem variação
    variationName: string;      // "Sem variação" quando variationId === null
    quantitySold: number;
    percentage: number;         // % sobre o total de unidades do produto (0–100, 2 casas decimais)
    remainingStock: number | null; // null = estoque ilimitado / não controlado
    totalStock: number | null;     // null = estoque ilimitado / não controlado
  }[];
}[];
```

### Exemplo de resposta

```json
{
  "message": "Dashboard data fetched successfully",
  "data": {
    "topProductVariations": [
      {
        "productId": "abc123",
        "productName": "Camiseta Oficial",
        "productImage": "https://cdn.example.com/img/camiseta.png",
        "totalQuantitySold": 120,
        "totalSoldAmount": 360000,
        "variations": [
          {
            "variationId": "var-m",
            "variationName": "M",
            "quantitySold": 70,
            "percentage": 58.33,
            "remainingStock": 30,
            "totalStock": 100
          },
          {
            "variationId": "var-g",
            "variationName": "G",
            "quantitySold": 50,
            "percentage": 41.67,
            "remainingStock": 50,
            "totalStock": 100
          }
        ]
      },
      {
        "productId": "def456",
        "productName": "Caneca",
        "productImage": null,
        "totalQuantitySold": 45,
        "totalSoldAmount": 90000,
        "variations": [
          {
            "variationId": null,
            "variationName": "Sem variação",
            "quantitySold": 45,
            "percentage": 100.00,
            "remainingStock": null,
            "totalStock": null
          }
        ]
      }
    ]
  }
}
```

---

## O que mudou em relação à versão anterior

| Campo                          | Antes    | Agora                                      |
|--------------------------------|----------|--------------------------------------------|
| `totalQuantitySold` (produto)  | ausente  | presente — total de unidades vendidas      |
| ordenação da lista             | sem ordem definida | ordenada por `totalQuantitySold` desc |
| `totalSoldAmount`              | presente | presente (sem mudança)                     |
| `variations[]`                 | presente | presente (sem mudança)                     |

---

## Regras de negócio

- **Ordenação:** produtos ordenados do mais vendido (maior `totalQuantitySold`) para o menos vendido.
- **`percentage`:** calculada sobre as unidades do próprio produto (`quantitySold / totalQuantitySold * 100`), arredondada a 2 casas decimais.
- **`remainingStock` / `totalStock`:** `null` quando o produto/variação tem estoque ilimitado (`stock = null` ou `stock = 0` no cadastro).
- **`variationId: null`:** linha especial `"Sem variação"` — aparece somente se houver vendas sem variação escolhida.
- **Variações com 0 vendas:** ainda aparecem na lista (com `quantitySold: 0`, `percentage: 0`).
- **Array vazio:** retornado quando não há inscrições pagas no período selecionado.

---

## Notas de integração

- `totalSoldAmount` está em **centavos** (dividir por 100 para exibir em R$).
- `totalQuantitySold` é a soma de `variations[].quantitySold`.
- As `variations` internas já vêm ordenadas do mais vendido para o menos vendido.
