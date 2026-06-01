# Geo (Estados/Províncias e Cidades por país) — Contrato Backend

Status: **proposto** (frontend já integrado com fallback; aguarda implementação no backend).

## Objetivo

No checkout (tela de pagamento → endereço de cobrança), quando o país selecionado é
**estrangeiro**, oferecer dropdowns em cascata **país → estado/província → cidade**, em vez
de texto livre. Hoje:

- **Brasil**: estado = lista fixa de 27 UFs (frontend) + cidade autopreenchida via ViaCEP.
- **Estrangeiro**: estado e cidade são **texto livre**.

Este contrato cobre **somente o estrangeiro**. O Brasil continua usando UF fixa + ViaCEP
(não consome estes endpoints) — pode ser migrado depois.

## Princípios

- **Dado de referência, estático e público**: não depende de autenticação nem de evento.
  Pode (e deve) ser cacheado agressivamente (`Cache-Control: public, max-age=86400`+).
- **Resiliência primeiro**: o frontend SEMPRE degrada para **texto livre** quando o endpoint
  falha, retorna lista vazia, ou o país não tem subdivisões. O checkout nunca é bloqueado por
  indisponibilidade de geo. Logo, publicar os endpoints é incremental — nada quebra antes.
- **Valor persistido = NOME legível**. O backend de pedidos já grava `billingAddress.state` e
  `billingAddress.city` como texto livre para estrangeiro. Os dropdowns apenas ajudam a
  escolher esses nomes. O `code` do estado é um identificador OPACO usado só para consultar as
  cidades — não é persistido.

## Envelope de resposta

Mesmo padrão do restante da API: `{ success: boolean, data: {...}, message?, timestamp? }`.

## Endpoints

### 1) Estados/Províncias de um país

```
GET /api/v1/geo/countries/:countryCode/states
```

- `:countryCode` — ISO 3166-1 **alpha-2**, maiúsculo (ex.: `US`, `AR`, `PT`, `IT`).
  O frontend resolve o nome PT-BR → alpha-2 com o mesmo helper do telefone
  (`getCountryCodeFromName`, base `i18n-iso-countries`).

**200 OK**

```jsonc
{
  "success": true,
  "data": {
    "states": [
      { "code": "CA", "name": "California" },
      { "code": "NY", "name": "New York" }
    ]
  }
}
```

- `code` (string, obrigatório): identificador **estável** da subdivisão dentro do país.
  Recomendado: parte de subdivisão do ISO 3166-2 (o que vem depois do `-`, ex.: `US-CA` → `CA`).
  Pode ser qualquer string estável do backend — o frontend trata como opaca.
- `name` (string, obrigatório): nome legível para exibição/persistência.
- Ordenar por `name` (locale-aware) — o frontend reordena defensivamente mesmo assim.
- País **sem** subdivisões (ex.: cidades-estado): retornar `"states": []`. O frontend cai em
  texto livre para estado e cidade.

### 2) Cidades de um estado/província

```
GET /api/v1/geo/countries/:countryCode/states/:stateCode/cities
```

- `:stateCode` — o `code` retornado pelo endpoint de estados.
- Query opcional (escalabilidade para estados grandes):
  - `search` (string): filtro por prefixo/substring no nome (case/acento-insensível).
  - `limit` (int, default sugerido 1000): teto de itens retornados.

> O frontend, na 1ª versão, busca a lista do estado e filtra **client-side**. `search`/`limit`
> são para o caso de estados com milhares de cidades — implementar quando necessário.

**200 OK**

```jsonc
{
  "success": true,
  "data": {
    "cities": [
      { "name": "Los Angeles" },
      { "name": "San Diego" },
      { "name": "San Francisco" }
    ]
  }
}
```

- `name` (string, obrigatório): nome da cidade (valor persistido em `billingAddress.city`).
- `id`/`code` são **opcionais** e ignorados pelo frontend (persiste-se o nome).
- Estado sem cidades catalogadas → `"cities": []` → frontend cai em texto livre para cidade.

## Erros / casos de borda (comportamento esperado do frontend)

| Situação | Resposta backend | Frontend |
|---|---|---|
| País inválido / não alpha-2 | `400` | fallback texto livre |
| País/estado sem dados | `200` com `[]` | fallback texto livre |
| Endpoint ainda não existe | `404`/`501` | fallback texto livre |
| Falha de rede / 5xx | qualquer | fallback texto livre |

Nenhum desses casos bloqueia o checkout — o usuário simplesmente digita estado/cidade.

## Cache

- `Cache-Control: public, max-age=86400, stale-while-revalidate=604800` (ou superior).
- Frontend (React Query): `staleTime: Infinity`, `gcTime` longo, `refetchOnMount: false`
  para estas queries (sobrescreve a política global "menos cache", pois geo é imutável).
  Ver `src/hooks/useGeo.ts`.

## Fonte de dados (sugestão, não-normativa)

Dataset estático mantido no backend (ex.: pacote `country-state-city`, GeoNames, ou tabela
própria seedada). O importante é o **contrato acima**; a origem dos dados é decisão do backend.

## Integração no frontend (já implementada)

- `src/services/geo/GeoService.ts` — `getStates(countryCode)`, `getCities(countryCode, stateCode)`.
- `src/hooks/useGeo.ts` — `useGeoStates(countryName)`, `useGeoCities(countryName, stateCode)`
  (resolvem alpha-2, cache longo, `enabled` só para país estrangeiro).
- `src/components/SearchSelect.tsx` — select com busca (estado/cidade), com estados de loading/vazio.
- `src/components/Checkout/CheckoutAddressSection.tsx` — ramo estrangeiro usa os dropdowns em
  cascata com **fallback automático** para texto livre.
- `queryKeys.geo` em `src/services/cache/QueryClient.ts`.
