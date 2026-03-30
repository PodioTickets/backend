# Integração — Admin: listagem global de audit logs

Documentação para consumir a rota que expõe o histórico de auditoria de **todas** as organizações, com **metadata completa** e, quando existir, o detalhamento campo a campo das alterações (`changeDetails`).

---

## Visão geral

| Item | Valor |
|------|--------|
| **Método** | `GET` |
| **Caminho** | `/api/v1/organizations/admin/audit-logs` |
| **Autenticação** | Bearer JWT (`Authorization: Bearer <token>`) |
| **Autorização** | **Temporariamente:** qualquer usuário autenticado (JWT válido). A checagem de papel `ADMIN` / `PODIOGO_STAFF` foi removida até nova definição. |
| **Cache** | Resposta marcada como não cacheável no servidor (`NoCache`) |

Esta rota **não** usa o header `x-api-bypass` (diferente de outras rotas `admin/*` do mesmo controller que são bypass). Exige apenas **JWT válido** (não precisa ser conta admin no estado atual).

---

## Query parameters

Todos opcionais. Envie como query string (ex.: `?page=1&limit=50`).

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `organizationId` | UUID | Restringe aos logs da organização indicada. |
| `kind` | string | Filtra por `metadata.kind` (correspondência exata no JSON). Ex.: `EVENT_UPDATE`, `TICKET_UPDATE`, `PRODUCT_UPDATE`, `PAGE_VIEW`, `MEMBER_ADD`. |
| `q` | string | Busca textual **insensível a maiúsculas** no campo `action` persistido no banco. |
| `from` | string (data) | Início do intervalo em `occurredAt` (inclusive). |
| `to` | string (data) | Fim do intervalo em `occurredAt` (o servidor normaliza o fim do dia UTC: 23:59:59.999). |
| `page` | number | Página (padrão: `1`, mínimo: `1`). |
| `limit` | number | Itens por página (padrão: `20`, máximo: `100`). |

**Datas:** use strings parseáveis por `new Date()` (ex.: ISO 8601 `2026-03-28` ou `2026-03-28T00:00:00.000Z`).

**Combinação de filtros:** todos os filtros informados são aplicados em conjunto (AND).

---

## Resposta de sucesso (`200`)

Envelope padrão:

```json
{
  "message": "Audit logs fetched successfully (admin)",
  "data": {
    "items": [ /* ... */ ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 150,
      "totalPages": 8
    }
  }
}
```

### Objeto em `data.items[]`

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | string (UUID) | Identificador do registro de log. |
| `organizationId` | string (UUID) | Organização à qual o log pertence. |
| `organization` | object \| null | `{ id, name, email }` da organização. |
| `ip` | string \| null | IP de origem, se registrado. |
| `userId` | string (UUID) \| null | Usuário que executou a ação (`actor`). |
| `userName` | string \| null | Nome exibido (`firstName` + `lastName`). |
| `kind` | string \| null | Valor de `metadata.kind` quando existir. |
| `action` | string | Texto da ação **para exibição** (edições de evento/ingresso/produto vêm sem o sufixo `(...)` que pode existir no banco em registros antigos). |
| `editedFields` | string \| null | Resumo legível dos campos editados (ex.: `nome, banner`) para tipos de edição conhecidos; `null` se não aplicável. |
| `changeDetails` | array \| null | Lista estruturada das mudanças; ver abaixo. `null` se não houver `metadata.changes` ou estiver vazio. |
| `occurredAt` | string (ISO 8601) | Momento do evento. |
| `metadata` | object \| null | **JSON completo** salvo no banco (inclui `kind`, `changes`, ids de contexto, etc.). |
| `storedAction` | string | Valor bruto do campo `action` no banco (útil para auditoria forense ou busca alinhada ao que foi persistido). |

### `changeDetails` (detalhe de edições e outros logs com `changes`)

Quando `metadata.changes` é um array de entradas `{ field, old, new }`, a API devolve:

```json
"changeDetails": [
  {
    "field": "name",
    "fieldLabel": "nome",
    "oldValue": "Evento Antigo",
    "newValue": "Evento Novo"
  }
]
```

| Campo | Descrição |
|-------|-----------|
| `field` | Chave técnica do campo (como no metadata). |
| `fieldLabel` | Rótulo em pt-BR quando mapeado (evento, ingresso, produto, equipe). |
| `oldValue` | Valor anterior (pode ser objeto/array/primitivo). |
| `newValue` | Valor novo. |

Para logs como criação de evento ou exclusão de produto, `changeDetails` pode trazer um único item com `oldValue`/`newValue` complexos (objetos aninhados), espelhando o que foi gravado em `metadata.changes`.

---

## Valores comuns de `metadata.kind`

Úteis para o filtro `kind=`:

- **Eventos:** `EVENT_CREATE`, `EVENT_UPDATE`
- **Ingressos / produtos:** `TICKET_UPDATE`, `PRODUCT_CREATE`, `PRODUCT_UPDATE`, `PRODUCT_DELETE`
- **Painel:** `PAGE_VIEW`
- **Equipe:** `MEMBER_ADD`, `MEMBER_REMOVE`, `MEMBER_ROLE`, `MEMBER_PERMISSIONS`, `MEMBER_EVENTS`, `MEMBER_SETTINGS`

A lista pode crescer com o tempo; trate `kind` desconhecido como string opaca e use `metadata` para inspeção completa.

---

## Exemplos

### Listar primeira página (padrão 20 itens)

```http
GET /api/v1/organizations/admin/audit-logs HTTP/1.1
Host: api.exemplo.com
Authorization: Bearer <access_token>
```

### Somente edições de evento, organização específica

```http
GET /api/v1/organizations/admin/audit-logs?organizationId=898a30a3-97c7-4a33-9d70-cd29559f143c&kind=EVENT_UPDATE&limit=50 HTTP/1.1
Authorization: Bearer <access_token>
```

### Intervalo de datas + busca no texto da ação

```http
GET /api/v1/organizations/admin/audit-logs?q=Editou&from=2026-03-01&to=2026-03-31&page=2&limit=25 HTTP/1.1
Authorization: Bearer <access_token>
```

### cURL

```bash
curl -sS -G "https://api.exemplo.com/api/v1/organizations/admin/audit-logs" \
  -H "Authorization: Bearer ${JWT}" \
  --data-urlencode "kind=EVENT_UPDATE" \
  --data-urlencode "page=1" \
  --data-urlencode "limit=50"
```

---

## Erros

| HTTP | Situação |
|------|----------|
| `401` | Token ausente, inválido ou expirado. |
| `400` | Parâmetros de query inválidos (validação do DTO, ex.: `organizationId` ou `page` fora do esperado). |

Corpo de erro segue o formato padrão da API (mensagem NestJS / filtros de exceção).

---

## Integração no front (admin)

1. Obter JWT de um usuário autenticado (no estado atual, não é obrigatório ser `ADMIN` / `PODIOGO_STAFF`).
2. Chamar `GET` com os filtros desejados; paginar com `page` / `limit` até `totalPages`.
3. Para telas de **diff** ou suporte: preferir renderizar a partir de **`changeDetails`**; usar **`metadata`** quando precisar de contexto extra (`eventId`, `ticketId`, `page`, etc.).
4. Para listagem compacta: usar **`action`** + **`editedFields`** + **`userName`** + **`organization.name`**.

---

## Contraste com a rota do organizador (owner)

| | Owner (`GET .../organizations/me/audit-logs`) | Admin (esta rota) |
|--|-----------------------------------------------|-------------------|
| Escopo | Uma organização (do owner logado) | Todas (filtro opcional por `organizationId`) |
| Auth | JWT do organizador + ser **owner** | JWT válido (papel admin **desativado** temporariamente) |
| `changeDetails` | Não exposto na listagem do owner | Sim |
| `organization` no item | Implícito | Objeto explícito em cada item |
