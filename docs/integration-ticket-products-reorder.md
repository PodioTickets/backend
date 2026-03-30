# Integração: reordenar produtos de um ingresso

Endpoint dedicado para alterar **somente a ordem de exibição** dos produtos vinculados a um ticket (`TicketProduct.sortOrder`). Não adiciona nem remove vínculos.

## Autenticação

| Requisito | Valor |
|-----------|--------|
| Método | Bearer JWT |
| Header | `Authorization: Bearer <access_token>` |

O usuário precisa ser membro da organização dona do evento (mesma regra dos demais endpoints de ingresso).

## Requisição

| Campo | Valor |
|-------|--------|
| Método HTTP | `PATCH` |
| URL | `{BASE_URL}/api/v1/tickets/events/{eventId}/{ticketId}/products/reorder` |

Substitua:

- `{BASE_URL}` — URL da API (ex.: `https://api.exemplo.com`)
- `{eventId}` — UUID do evento
- `{ticketId}` — UUID do ingresso

### Corpo (JSON)

```json
{
  "productIds": [
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "ffffffff-gggg-hhhh-iiii-jjjjjjjjjjjj"
  ]
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `productIds` | `string[]` (UUID v4) | Sim | Lista **completa** dos produtos já vinculados ao ingresso, na **ordem desejada** (primeiro item = ordem 0). |

### Regras de validação

1. **Mesmo conjunto**: `productIds` deve ter **exatamente** os mesmos IDs que já estão ligados ao ticket — nem a mais, nem a menos.
2. **Sem duplicatas**: cada UUID pode aparecer no máximo uma vez.
3. **Ingresso sem produtos**: envie `"productIds": []` (lista vazia). Não há alteração de linhas no banco.
4. **IDs inválidos**: qualquer `productId` que não esteja vinculado a esse ticket → erro `400`.

## Respostas

### 200 OK

```json
{
  "message": "Ticket products reordered successfully",
  "data": {
    "ticketId": "uuid-do-ingresso",
    "productIds": [
      "uuid-na-nova-ordem-1",
      "uuid-na-nova-ordem-2"
    ]
  }
}
```

`data.productIds` reflete a ordem persistida (igual à enviada, em caso de sucesso).

### Erros comuns

| HTTP | Cenário |
|------|---------|
| `400` | Lista com tamanho diferente da quantidade de vínculos; produto não vinculado ao ticket; IDs duplicados no body; falha de validação do DTO. |
| `401` | Token ausente ou inválido. |
| `403` | Usuário não é membro da organização do evento. |
| `404` | `eventId`/`ticketId` inexistente ou ingresso não pertence ao evento informado. |

Mensagens de `400` úteis para o cliente:

- `productIds must list every product linked to this ticket exactly once, in the new order`
- `Product <uuid> is not linked to this ticket`

## Exemplo cURL

```bash
curl -X PATCH \
  "${BASE_URL}/api/v1/tickets/events/${EVENT_ID}/${TICKET_ID}/products/reorder" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "productIds": [
      "11111111-2222-3333-4444-555555555555",
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    ]
  }'
```

## Relação com o PATCH geral do ingresso

- No **PATCH** `/api/v1/tickets/events/:eventId/:ticketId`, o campo `productIds` **substitui** todos os vínculos; a ordem do array também define `sortOrder`.
- Use este endpoint **`/products/reorder`** quando quiser **só reordenar**, sem tocar em nome, lotes, kit, etc., e com uma validação explícita de “mesmo conjunto de produtos”.

## OpenAPI / Swagger

O endpoint está documentado no Swagger do projeto (`ReorderTicketProductsDto`, tag **Tickets**), útil para gerar clientes ou testar no browser com o token configurado.
