# Registrations GET — `/registrations/:id`

> **Base URL:** `https://<api-host>/api/v1`
> **Fonte:** `registrations.controller.ts` (`findOne`) + `registrations.service.ts` + `order-finalization.service.ts` (construção do snapshot)
> **Atualizado:** 2026-05-30

Documento de referência do payload retornado por `GET /api/v1/registrations/:id`.

> ### ⚠️ Esta rota retorna **SOMENTE o snapshot imutável** — zero dados ao vivo
> O corpo da inscrição vem **inteiramente** do `receiptSnapshot` (recibo congelado no momento
> do pagamento). **Não há joins ao vivo** com `Event`, `Ticket`, `Product`, etc. Isso garante que
> a inscrição é exibida **exatamente como foi comprada**, mesmo que o organizador edite/exclua
> evento, ingresso ou produtos depois. Apenas `id`, `status` e `qrCode` vêm da própria linha de
> `Registration` (são identidade/estado da inscrição, não dados externos sujeitos a drift).

---

## Visão geral

| | `GET /registrations/:id` (`findOne`) |
|---|---|
| Identificador | UUID da `Registration` |
| Auth | `JwtAuthGuard` (autenticado) |
| Envelope | `{ message, data: { registration } }` |
| Fonte dos dados | `Registration.receiptSnapshot` (snapshot) + `id`/`status`/`qrCode` |
| Cache | sem `@NoCache` — sujeito ao `Cache-Control` global (`no-store` por default) |

> Rotas relacionadas (NÃO cobertas aqui): `GET /registrations/me/:id` (`findMyRegistration`,
> shape mais rico, mistura snapshot + alguns campos ao vivo) e
> `GET /registrations/:id/payment-details` (detalhes de pagamento).

---

## Controle de acesso

A rota valida o solicitante **antes** de retornar (HTTP 400 `Acesso negado` caso contrário).
Tem acesso quem satisfizer **qualquer** um dos critérios:

| Critério | Condição |
|---|---|
| **Participante** | `registration.userId === userId` |
| **Comprador** | `registration.order.userId === userId` |
| **Convidador** | `registration.invitedById === userId` |
| **CPF correspondente** | `user.documentNumberClean === registration.participantCpfClean` |
| **Admin** | `user.role ∈ { PODIOGO_STAFF, ADMIN }` |
| **Organizador** | membro da `OrganizationMember` da organização dona do evento (`event.organizationId`) |

> O check de organizador usa o **mesmo critério** de `getPaymentDetails` (consulta
> `organizationMember.findFirst({ organizationId, userId })`) e só roda quando nenhum dos
> critérios diretos bate (sem custo no caminho comum).

| HTTP | Quando |
|---|---|
| `200` | acesso liberado |
| `404` | `Inscrição não encontrada` |
| `400` | `Acesso negado — você só pode visualizar suas próprias inscrições` |
| `401` | sem token / token inválido |

---

## Envelope

```jsonc
{
  "message": "Registration fetched successfully",
  "data": {
    "registration": {
      // identidade/estado da própria inscrição
      "id": "dabaf3e5-66e2-4d80-92d1-aedb392cef72",
      "status": "CONFIRMED",
      "qrCode": "https://www.podioticket.com.br/user/tickets/<id>",
      // ...todo o conteúdo do receiptSnapshot (espalhado no mesmo nível) ↓
    }
  }
}
```

Os campos abaixo do snapshot são **espalhados (spread)** no mesmo nível de `id`/`status`/`qrCode`.

---

## Campos do snapshot

> **Valores monetários em CENTAVOS** (`int`). Ex.: `finalTotal: 6120` = R$ 61,20.

### `id` / `status` / `qrCode` (da Registration, não do snapshot)
| Campo | Tipo | Observação |
|---|---|---|
| `id` | `string (uuid)` | id da inscrição |
| `status` | `enum` | `PENDING` \| `CONFIRMED` \| `CANCELLED` |
| `qrCode` | `string` | URL do ticket (`qrCode` persistido no finalize; fallback gerado por id) |

### `event`
| Campo | Tipo |
|---|---|
| `id` | `string (uuid)` |
| `name` | `string` |
| `slug` | `string` |
| `description` | `string \| null` (HTML) |
| `eventDate` | `string (ISO)` |
| `registrationStartDate` | `string (ISO) \| null` |
| `registrationEndDate` | `string (ISO) \| null` |
| `bannerUrl` | `string \| null` |
| `logoUrl` | `string \| null` |
| `organization` | `{ id, name, logoUrl, email, phone } \| null` |
| `location` | `{ name, neighborhood, city, state, country, zipCode, googleMapsLink }` |

### `ticket`
| Campo | Tipo |
|---|---|
| `id` | `string (uuid)` |
| `name` | `string` |
| `description` | `string \| null` |
| `modality` | `string \| null` |
| `distance` | `string \| null` |
| `distanceUnit` | `string \| null` |
| `gender` | `string \| null` |
| `ageLimitMin` | `number \| null` |
| `ageLimitMax` | `number \| null` |
| `category` | `{ id, name } \| null` |
| `batch` | `{ id, name, price } \| null` (preço em centavos) |

### `products[]` (produtos adicionais do participante)
| Campo | Tipo |
|---|---|
| `id` | `string (uuid)` |
| `name` | `string` |
| `images` | `string[]` |
| `primaryImageIndex` | `number` |
| `basePrice` | `number` (centavos) |
| `unitPrice` | `number` (centavos) |
| `quantity` | `number` |
| `variationType` | `string \| null` |
| `selectedVariation` | `{ id, name, price, ... } \| null` |
| `variationEdited` | `boolean` — `true` se o comprador trocou a variação após a compra (via `PATCH /registrations/:id/products/:productId/variation`) |

> #### ⚠️ Exceção ao "snapshot-only": variação do produto
> `variationEdited` e a variação atual são estado **mutável pós-compra** — vivem no
> `RegistrationProduct`, **não** no snapshot (que congela a variação ORIGINAL no pagamento e
> não é reescrito pela edição). Por isso o endpoint **mescla** esse recorte ao vivo nos produtos:
> - `variationEdited` reflete se houve troca;
> - quando `variationEdited === true`, `selectedVariation` é **substituído pela variação ATUAL**
>   (a do snapshot ficaria defasada). Sem edição, `selectedVariation` é a do snapshot.
>
> O match snapshot↔RegistrationProduct é por `productId` (o `id` do produto no snapshot).

### `participant`
| Campo | Tipo |
|---|---|
| `name` | `string \| null` |
| `email` | `string \| null` |
| `cpf` | `string \| null` (legado; use `documentNumber`/`documentType`) |
| `documentType` | `enum \| null` (`CPF` \| `PASSPORT` \| ...) |
| `documentNumber` | `string \| null` |
| `phone` | `string \| null` |
| `birthDate` | `string \| null` |
| `gender` | `string \| null` |
| `country` | `string \| null` |

### `billing` (endereço de cobrança)
| Campo | Tipo |
|---|---|
| `postalCode` | `string \| null` |
| `street` | `string \| null` |
| `number` | `string \| null` |
| `complement` | `string \| null` |
| `neighborhood` | `string \| null` |
| `city` | `string \| null` |
| `state` | `string \| null` |
| `country` | `string \| null` |

### `pricing`
| Campo | Tipo |
|---|---|
| `ticketsSubtotal` | `number` (centavos) |
| `productsSubtotal` | `number` (centavos) |
| `discount` | `number` (centavos) |
| `pixDiscount` | `number` (centavos) |
| `finalTotal` | `number` (centavos — valor efetivamente cobrado) |
| `coupon` | `{ id, code, type, value, applyToProducts } \| null` |
| `voucher` | `{ id, code, name, applyToProducts } \| null` |

### `questionAnswers[]`
| Campo | Tipo |
|---|---|
| `answer` | `string` (pode ser JSON serializado p/ múltipla escolha, ex.: `"[\"Doar 10\"]"`) |
| `question` | `{ id, question, description, type, options, isRequired }` |

### `paidAt`
| Campo | Tipo |
|---|---|
| `paidAt` | `string (ISO)` — momento do pagamento (congelado no finalize) |

---

## Exemplo de resposta (real, homolog)

```jsonc
{
  "message": "Registration fetched successfully",
  "data": {
    "registration": {
      "id": "dabaf3e5-66e2-4d80-92d1-aedb392cef72",
      "status": "CONFIRMED",
      "qrCode": "https://www.podioticket.com.br/user/tickets/dabaf3e5-...",
      "event": {
        "id": "999ef0df-a1a3-4e10-95eb-7b2b8df6f0c7",
        "name": "MARATONA INTERNACIONAL DE MACEIÓ 2026",
        "slug": "maratona-internacional-de-maceio-2026-a1a3",
        "eventDate": "2026-06-22T00:00:00.000Z",
        "logoUrl": "https://.../logo.png",
        "organization": { "id": "48c2...", "name": "Minha Empresa LTDA", "email": "contato@empresa.com", "phone": "5959595959", "logoUrl": "https://.../org.webp" },
        "location": { "name": "Av Governador Mario Covas", "neighborhood": "Centro", "city": "Miracatu", "state": "SP", "country": "BR", "zipCode": "11850-000", "googleMapsLink": "https://maps.app.goo.gl/..." }
      },
      "ticket": { "id": "e3632238-...", "name": "100 reais", "modality": "Corrida", "distance": "14", "distanceUnit": "KM", "gender": "all", "category": null, "batch": { "id": "b85f9dd0-...", "price": 10000 } },
      "products": [
        { "id": "504d15b7-...", "name": "Camiseta da nike", "images": ["https://.../camiseta.png"], "primaryImageIndex": 0, "basePrice": 1000, "unitPrice": 1000, "quantity": 1, "variationType": "Tamanho", "selectedVariation": { "id": "e66b...", "name": "G", "price": 0 }, "variationEdited": false }
      ],
      "participant": { "name": "Test 5", "email": "teste5@gmail.com", "phone": "791234567", "gender": "OTHER", "country": "Afeganistão", "birthDate": "1994-04-07", "documentType": "PASSPORT", "documentNumber": "12312321312312" },
      "billing": { "city": "Miracatu", "number": "131", "street": "asfsaf", "country": "Afeganistão", "postalCode": "11850000" },
      "pricing": { "ticketsSubtotal": 10000, "productsSubtotal": 1000, "discount": 5000, "pixDiscount": 0, "finalTotal": 6120, "coupon": { "id": "bbc4...", "code": null, "type": "PERCENTAGE", "value": 50, "applyToProducts": false }, "voucher": null },
      "questionAnswers": [ { "answer": "[\"Doar 10 Conto\"]", "question": { "id": "6c6b...", "type": "select", "options": ["Nao, obrigado", "Doar 10 Conto"], "question": "Deseja doar?", "isRequired": true, "description": "" } } ],
      "paidAt": "2026-05-30T00:27:07.080Z"
    }
  }
}
```

---

## Pós-processamento global (afeta TODA resposta)

- **Strip de null/vazio:** o `ResponseCompressionInterceptor` global **remove toda chave** cujo valor
  seja `null`, `undefined` ou `""`. Portanto campos nulos/vazios do snapshot **não aparecem** no JSON
  (ex.: `state: null`, `complement: null`, `category: null` somem). O front deve tratar a **ausência**
  da chave como "sem valor".
- **Cache-Control:** sem `@NoCache`/`@Header`, o `SecurityHeadersInterceptor` aplica `no-store` por
  default.

---

## Fallback (inscrições sem snapshot)

Se a inscrição **não tiver** `receiptSnapshot` (legada — anterior ao recurso de snapshot — ou ainda
`PENDING`/não paga), o `findOne` cai no método interno `findOneLive`, que monta a resposta a partir
de **joins ao vivo** (shape antigo: `user`, `modalities`, `ticket.includedProducts`, `kitItems`,
`products`, `emergencyContact`). Esse caminho existe só para não deixar a rota vazia nesses casos;
o caminho **padrão/esperado** (inscrição paga) é 100% snapshot.
