# Audit do organizador — integração no frontend

Este documento descreve o que o painel do organizador precisa enviar ao backend para **páginas acessadas** e **contexto de edição** nos logs de auditoria (`GET /api/v1/organizations/me/audit-logs`, apenas dono).

Todas as rotas abaixo usam o **mesmo JWT** do organizador (`Authorization: Bearer …`).

---

## 1. Registrar acesso a páginas (page views)

### Endpoint

`POST /api/v1/organizations/me/audit/page-view`

### Body (JSON)

| Campo      | Tipo   | Obrigatório | Descrição |
|------------|--------|-------------|-----------|
| `pageKey`  | string | sim         | Identificador estável da rota/tela (veja convenções abaixo). |

Exemplo:

```json
{ "pageKey": "dashboard" }
```

### Quando chamar

- **Uma vez por “entrada” na tela**, no ciclo de vida equivalente a **montagem da rota** (ex.: `useEffect` vazio, `onMounted`, após navegação concluída).
- **Não** é necessário chamar de novo a cada re-render interno; o dedupe no servidor cobre F5 e recarregamentos na mesma janela de tempo.

### Comportamento no servidor (deduplicação)

- Para cada combinação **`organizationId` + usuário + `pageKey`**, só é gravado um novo log se passaram **pelo menos ~30 minutos** desde o último registro dessa combinação.
- Vários F5 seguidos na mesma página → **conta como um único** log (até expirar a janela).
- Respostas típicas:
  - `{ "message": "Page view recorded", "data": { "recorded": true, "pageKey": "…" } }`
  - `{ "message": "Page view omitted (deduplicated)", "data": { "recorded": false, "pageKey": "…" } }`
- Se o usuário **não for membro** de nenhuma organização → **403**.

### Erros

- `pageKey` vazio ou só espaços → **400**.
- Não autenticado → **401**.

### Convenção sugerida para `pageKey`

Use strings **curtas e estáveis** (sem query string), alinhadas às rotas do app:

| Exemplo de rota no app      | `pageKey` sugerido        |
|----------------------------|---------------------------|
| `/organizer` ou dashboard  | `dashboard`               |
| Lista de eventos           | `events`                  |
| Edição geral do evento X   | `events/:eventId/general` ou `event-edit` + manter `eventId` em outro lugar só no cliente |
| Ingressos do evento X      | `events/:eventId/tickets` |
| Equipe / membros           | `members` ou `members/list` |
| Detalhe do membro Y        | `members/:userId`         |
| Configurações da org       | `organization-settings`   |

O importante é **consistência**: a mesma tela deve sempre usar o **mesmo** `pageKey`, para o relatório de auditoria fazer sentido.

---

## 2. Edição de evento — contexto da página (`clientPage`)

No **`PATCH /api/v1/events/:id`**, além dos campos já enviados hoje, pode incluir:

| Campo         | Tipo   | Obrigatório | Descrição |
|---------------|--------|-------------|-----------|
| `clientPage`  | string | não         | Onde o usuário salvou (ex.: `events/abc123/general`). |

- O campo **não é persistido** no modelo do evento; serve só para **`metadata.page`** no log.
- Se omitido, o servidor usa o padrão **`event-edit`**.
- O servidor só grava log de alteração se houver **mudança real de valor** nos campos enviados; campos iguais ao que já está salvo **não** entram no audit.

### Criação de evento

`POST /api/v1/events` **não** precisa de `clientPage`. O audit de criação é sempre resumido no servidor como **“Criou o evento …”**.

---

## 3. Edição de membros da equipe — `clientPage`

Inclua **`clientPage`** no body quando fizer estas chamadas (opcional em todos; padrões do servidor entre parênteses):

| Método + rota (ajuste ao seu prefixo) | DTO / body | Padrão de `page` no log se omitir |
|--------------------------------------|------------|-------------------------------------|
| `PATCH` membro (settings combinados) | `PatchMemberSettingsDto` | `member-settings` |
| `PUT` / `PATCH` papel do membro      | `UpdateMemberRoleDto`    | `member-role` |
| `PUT` permissões do membro           | `PutMemberPermissionsDto`| `member-permissions` |
| `PUT` eventos do membro              | `PutMemberEventsDto`     | `member-events` |

Exemplo (permissões):

```json
{
  "permissions": ["dashboard", "edit_event"],
  "clientPage": "members/uuid-da-pessoa/permissions"
}
```

- Se não houver **mudança efetiva** (ex.: mesmas permissões), o servidor **não** cria linha de audit nesses fluxos de PUT/patch de membros (evita ruído).

---

## 4. Leitura dos logs (tela “Histórico” / auditoria)

### Endpoint

`GET /api/v1/organizations/me/audit-logs`

Query opcional: `q`, `from`, `to`, `page`, `limit` (ver `OrganizationAuditLogQueryDto`).

Apenas **dono (OWNER)** da organização consegue listar.

### Campos úteis por item

- `action` — texto legível (pt-BR).
- `occurredAt` — data/hora.
- `metadata` — JSON com detalhes estruturados (ver abaixo).
- `actor` / usuário — conforme retorno da API de listagem.

### `metadata.kind` (referência rápida)

| `kind`              | Significado |
|---------------------|-------------|
| `PAGE_VIEW`         | Acesso a página; `metadata.page` = `pageKey` enviado. |
| `EVENT_CREATE`      | Criação de evento; `eventId`. |
| `EVENT_UPDATE`      | Edição com diff; `page`, `fieldsEdited[]`, `changes[]` (`field`, `old`, `new`). |
| `MEMBER_ROLE`       | Papel alterado; `page`, `memberUserId`, `fieldsEdited`, `changes`. |
| `MEMBER_PERMISSIONS`| Permissões; `page`, `memberUserId`, `changes`, `permissionKeys`. |
| `MEMBER_EVENTS`     | Eventos liberados ao membro; `page`, `memberUserId`, `changes`, `eventIds`. |
| `MEMBER_SETTINGS`   | Patch combinado; `page`, `memberUserId`, `fieldsEdited`, `changes`. |
| Outros (`MEMBER_ADD`, `MEMBER_REMOVE`, …) | Podem não ter `page`/`changes`; use `action` + `kind`. |

Use `metadata.changes` para exibir **valor anterior / novo** quando existir.

---

## 5. Checklist de implementação

1. **Router / layout do painel**  
   - Após navegação para cada rota “principal”, `POST …/me/audit/page-view` com `pageKey` estável.

2. **Formulários de evento**  
   - No submit do `PATCH /events/:id`, anexar `clientPage` coerente com a sub-rota (geral, ingressos, etc.).

3. **Telas de equipe**  
   - Nos PUT/PATCH de membro, anexar `clientPage` (ex.: rota atual).

4. **Tela de auditoria (owner)**  
   - Consumir `GET …/me/audit-logs` e renderizar `action`, data, e opcionalmente expandir `metadata` (página, campos, `changes`).

5. **Erros**  
   - `403` em page-view: usuário não é membro de organização — normalmente não mostrar o painel; pode ignorar o call ou não disparar.

---

## 6. Observações

- **Rate limiting / rede**: falhas ocasionais no `page-view` não bloqueiam o fluxo do usuário; pode logar em debug e seguir.
- **Privacidade**: `changes` pode conter textos longos (ex.: descrição); avalie truncar na UI se necessário.
- Este documento reflete o comportamento do **backend Nest** neste repositório; se o frontend usar um BFF, replique os mesmos contratos lá.
