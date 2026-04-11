# Checkout Reservation Flow — Contrato Backend

Documento de contrato para o servidor implementar o fluxo de reserva temporária de ingressos com timer de 30 minutos e geração incremental de pedido durante o checkout.

Autor: Frontend (Podio Tickets)
Status: **Proposta — aguardando implementação no backend**
Consumido por: `src/app/checkout/**`, `src/components/Checkout/**`, `src/hooks/useCheckoutReservation.ts` (novo)

---

## 1. Objetivo

Hoje, o backend expõe um único endpoint monolítico `POST /api/v1/checkout/process` que, na mesma chamada:
1. Cria o pedido (`Order`)
2. Cria as `Registrations`
3. Debita o estoque do lote (`Batch`)
4. Cobra o pagamento (cartão) ou gera a cobrança (PIX)

Isso tem dois problemas que precisamos resolver:

- **Race condition de estoque**: dois usuários chegam simultaneamente na etapa de pagamento e só o segundo descobre, depois de digitar o cartão, que o lote esgotou.
- **Sem janela de confirmação**: o usuário não tem tempo garantido pra terminar o checkout, pode perder o ingresso enquanto preenche endereço.

A solução é **quebrar o fluxo em duas fases**:

- **Fase de reserva** (início da etapa `informacoes`): cria o pedido em status `PENDING`, desconta o estoque do lote, inicia um timer de 30 minutos autoritativo no servidor.
- **Fase de pagamento** (confirmação do endereço + método escolhido): tenta cobrar. Se der certo → `PAID`. Se der errado ou o timer expirar → `CANCELLED` e o estoque volta pro lote.

O pedido **nunca é deletado**. Ele apenas transita entre os estados `PENDING`, `CANCELLED` e `PAID`.

---

## 2. Máquina de estados do `Order`

```
                                   ┌──────────────┐
    [entra em /informacoes]        │              │
    POST /orders/reserve ─────────▶│   PENDING    │
                                   │              │
                                   └───┬──────┬───┘
                                       │      │
     ┌─────────────────────────────────┘      └─────────────────────────┐
     │ pagamento aprovado                  timer expirou (server-side)  │
     │ POST /orders/{id}/pay OK            OU pagamento falhou          │
     ▼                                     ▼
┌──────────┐                          ┌────────────┐
│   PAID   │                          │ CANCELLED  │
└──────────┘                          └────────────┘
  (terminal)                             (terminal)
```

### Regras de transição

| De        | Para        | Gatilho                                                                                 |
|-----------|-------------|-----------------------------------------------------------------------------------------|
| —         | `PENDING`   | `POST /orders/reserve` bem-sucedido                                                     |
| `PENDING` | `PAID`      | `POST /orders/{id}/pay` → provedor aprovou (cartão) OU webhook PIX confirmou           |
| `PENDING` | `CANCELLED` | `expiresAt <= now()` (job do servidor) OU provedor recusou cobrança (cartão)           |
| `PAID`    | —           | terminal                                                                                |
| `CANCELLED` | —         | terminal                                                                                |

**Importante**: `PENDING → CANCELLED` por expiração **não depende do frontend**. O servidor tem um job/cron que varre pedidos `PENDING` com `expiresAt` vencido e os move pra `CANCELLED`, devolvendo o estoque. Se o usuário fechar a aba, o pedido ainda conta o tempo e é cancelado sozinho.

**Webhook PIX após expiração — regra crítica**: se o webhook do provedor chegar **depois** de `expiresAt` mas antes do job ter cancelado o pedido (janela pequena mas real), a transição `PENDING → PAID` **é permitida** desde que a confirmação do provedor seja mais antiga que `expiresAt + 2min` (grace period). Fora desse grace, o webhook deve **estornar a cobrança** no provedor e deixar o pedido em `CANCELLED`. Essa regra precisa estar documentada no handler do webhook porque é a fonte mais comum de bugs em checkouts com timer.

### Estoque do lote

- `POST /orders/reserve` **decrementa** `batch.availableQuantity` atomicamente (transaction). Se não houver estoque suficiente, retorna `409 CONFLICT`.
- `PENDING → CANCELLED` **devolve** o estoque (`availableQuantity += quantity`) na mesma transação da mudança de status.
- `PENDING → PAID` **não mexe** no estoque — já foi debitado na reserva.

A contagem pública de "ingressos disponíveis" exibida nas páginas de evento deve refletir `availableQuantity` (que já considera reservas pendentes). Ingressos `PENDING` **não** estão disponíveis para outros compradores.

---

## 3. Endpoints

Todos os endpoints exigem `Authorization: Bearer <jwt>` e respondem JSON. Base: `/api/v1`.

### Regras globais (aplicam a todos os endpoints de `/orders/{orderId}`)

1. **Ownership check obrigatório (anti-IDOR).** Toda rota que recebe `{orderId}` precisa validar, **antes de qualquer lógica de negócio**, que `order.userId === req.user.id`. Se não bater, responder `404 ORDER_NOT_FOUND` (nunca `403` — não queremos confirmar existência de recursos de terceiros). Sem isso, qualquer usuário autenticado pode ler/alterar pedidos dos outros.
2. **Rate limit por user** no `POST /orders/reserve`: **5 requisições por minuto**. Evita abuso de usuário malicioso segurando estoque de múltiplos eventos. Use token bucket em Redis.
3. **Cap de PENDING concorrentes por user**: máximo **3 pedidos `PENDING`** simultâneos por `userId` no sistema inteiro. Quarta reserva retorna `409 TOO_MANY_PENDING_ORDERS`.
4. **Todas as respostas que carregam estado do pedido incluem `serverTime`** (ISO 8601 com ms). É obrigatório — o cliente usa isso pra corrigir drift de relógio.

### 3.1 `POST /orders/reserve`

Cria o pedido em `PENDING` e reserva os ingressos. Chamado pelo frontend **ao clicar em "Avançar" na etapa `ingressos`**, antes de navegar para `informacoes`.

**Request body:**
```json
{
  "eventId": "evt_abc123",
  "tickets": [
    { "ticketId": "tkt_xxx", "batchId": "bch_yyy", "quantity": 2 },
    { "ticketId": "tkt_zzz", "batchId": "bch_www", "quantity": 1 }
  ]
}
```

**Response `201 Created`:**
```json
{
  "orderId": "ord_01HXYZABC...",
  "status": "PENDING",
  "reservedAt": "2026-04-10T19:30:00.000Z",
  "expiresAt": "2026-04-10T20:00:00.000Z",
  "serverTime": "2026-04-10T19:30:00.123Z",
  "tickets": [
    {
      "ticketId": "tkt_xxx",
      "batchId": "bch_yyy",
      "quantity": 2,
      "unitPrice": 15000,
      "batchName": "1º Lote"
    }
  ],
  "pricing": {
    "subtotal": 45000,
    "serviceFee": 4500,
    "total": 49500,
    "currency": "BRL"
  }
}
```

- `expiresAt` = `reservedAt + 30 minutos`. Esse valor é **autoritativo** — o frontend calcula o countdown como `expiresAt - serverTime` e faz drift correction usando `serverTime` vs `Date.now()` local.
- `serverTime` é o `now()` do servidor no momento da resposta (usado pra corrigir relógio local).
- Valores monetários sempre em **centavos** (inteiros), para evitar problemas de ponto flutuante. `45000` = R$ 450,00.
- Se o usuário já tiver um pedido `PENDING` ativo pro mesmo `eventId`, o servidor deve **retornar o existente** (mesmo `orderId`, mesmo `expiresAt`) — idempotência.

**Erros:**

| Status | Código                  | Quando                                                             |
|--------|-------------------------|--------------------------------------------------------------------|
| 400    | `INVALID_PAYLOAD`       | corpo malformado                                                   |
| 401    | `UNAUTHORIZED`          | sem token válido                                                   |
| 404    | `EVENT_NOT_FOUND`       | `eventId` não existe                                               |
| 404    | `BATCH_NOT_FOUND`       | `batchId` não existe ou não pertence ao ticket                     |
| 409    | `BATCH_SOLD_OUT`        | `availableQuantity < quantity` pedido                              |
| 409    | `BATCH_NOT_ACTIVE`      | lote fora da janela de vendas                                      |
| 422    | `QUANTITY_EXCEEDED`     | quantidade acima do permitido por compra                           |

Body de erro sempre segue:
```json
{ "statusCode": 409, "code": "BATCH_SOLD_OUT", "message": "..." }
```

### 3.2 `GET /orders/{orderId}`

Retorna o estado atual do pedido. Usado pelo frontend pra:
- **Sincronizar o timer** se o usuário recarregar a página (o countdown vem de `expiresAt`, não de estado local).
- Verificar se o pedido já foi cancelado por expiração antes de deixar o usuário prosseguir.

**Response `200 OK`:**
```json
{
  "orderId": "ord_01HXYZABC...",
  "status": "PENDING",
  "reservedAt": "2026-04-10T19:30:00.000Z",
  "expiresAt": "2026-04-10T20:00:00.000Z",
  "serverTime": "2026-04-10T19:42:17.456Z",
  "eventId": "evt_abc123",
  "tickets": [ /* mesmo shape do reserve */ ],
  "pricing": { /* mesmo shape do reserve */ }
}
```

Se `status === "CANCELLED"`, o frontend expulsa o usuário pra página do evento.

### 3.3 `PATCH /orders/{orderId}/participants`

Persiste os dados dos participantes. Chamado **uma única vez** ao usuário clicar em "Avançar" na etapa `informacoes` — não há autosave. O servidor faz replace completo do array.

**Request body:**
```json
{
  "participants": [
    {
      "name": "Fulano de Tal",
      "cpf": "12345678900",
      "email": "fulano@exemplo.com",
      "birthDate": "1990-01-15",
      "phone": "+5511999999999",
      "gender": "MALE",
      "emergencyContactName": "Ciclana",
      "emergencyPhone": "+5511988888888",
      "questionAnswers": [
        { "questionId": "q_1", "answer": "camiseta M" }
      ]
    }
  ]
}
```

**Response `200 OK`:** mesmo shape do `GET /orders/{id}`.

**Erros:**
- `409 ORDER_NOT_PENDING` se o pedido não estiver mais em `PENDING` (expirado, pago, etc.).
- `422 VALIDATION_ERROR` com `fields: [{ path, message }]` pra cada campo inválido.

### 3.4 `PATCH /orders/{orderId}/products`

Persiste a lista de produtos opcionais. Chamado **uma única vez** ao avançar da etapa `produtos` pra `pagamento`. Mesmo padrão do `participants` (replace completo).

**Request body:**
```json
{
  "products": [
    { "productId": "prd_xxx", "variationId": "var_yyy", "quantity": 1 }
  ]
}
```

**Response `200 OK`:** pedido atualizado. O `pricing.total` deve refletir o novo subtotal com os produtos.

### 3.5 `PATCH /orders/{orderId}/billing-address`

Salva o endereço de cobrança confirmado na etapa `pagamento` (antes do usuário escolher o método).

**Request body:**
```json
{
  "billingAddress": {
    "country": "Brasil",
    "postalCode": "01310100",
    "stateUf": "SP",
    "street": "Av. Paulista",
    "number": "1000",
    "complement": "Apto 42",
    "neighborhood": "Bela Vista",
    "city": "São Paulo"
  }
}
```

**Response `200 OK`:** pedido atualizado.

> Nota: essa etapa **não** muda o status do pedido. Ele continua `PENDING`. O endereço é pré-requisito pro `POST /pay`.

### 3.6 `POST /orders/{orderId}/pay`

Processa o pagamento. Esse é o endpoint que antes era `POST /checkout/process`.

**Headers obrigatórios:**
```
Authorization: Bearer <jwt>
Idempotency-Key: <uuid-v4 gerado pelo cliente>
Content-Type: application/json
```

**`Idempotency-Key` (crítico):** o cliente gera um UUID v4 **antes** de exibir o botão "Finalizar compra" e reutiliza o mesmo valor em todos os retries. O servidor deve:
- Guardar `{idempotencyKey, userId, orderId}` → `{responseStatus, responseBody}` em cache Redis com TTL de 24h.
- Na primeira chamada, processa normalmente e grava o resultado.
- Em chamadas subsequentes com a mesma key, **retorna a resposta gravada sem re-executar** a cobrança.
- Se a key for reutilizada com corpo diferente (ex.: trocou de PIX pra cartão), responder `422 IDEMPOTENCY_KEY_MISMATCH`.

Sem isso, double-click, retry de rede, e back-forward cache do navegador cobram duas vezes o cartão do usuário.

**Atomicidade do pagamento aprovado (transaction):**

Quando o provedor aprova (cartão síncrono) ou o webhook do PIX confirma, o servidor precisa executar em **uma única transação**:

1. Verificar que `order.status === 'PENDING'` E `order.expiresAt > now() - 2min` (grace)
2. Criar todas as `Registrations` com seus QR codes
3. Mover `order.status` pra `PAID`
4. Gravar `payment.status = approved`, `payment.paidAt = now()`

Se qualquer passo **depois** de a cobrança ter sido feita no provedor falhar, precisa:
- **Compensação**: estornar a cobrança no provedor (cartão) ou marcar pra estorno automático (PIX)
- Logar o incidente com severidade alta
- Mover pedido pra `CANCELLED` com `cancelledReason = 'PAYMENT_RECONCILIATION_FAILED'`

Sem essa compensação, dá pra ter pedidos `PENDING` com dinheiro cobrado no provedor — é a pior coisa que pode acontecer num checkout.

**Request body — cartão:**
```json
{
  "method": "CREDIT_CARD",
  "card": {
    "name": "FULANO DE TAL",
    "number": "4111111111111111",
    "expiry": "12/30",
    "cvv": "123",
    "installments": 3
  },
  "couponCode": "PROMO10",
  "voucherCode": null
}
```

**Request body — PIX:**
```json
{
  "method": "PIX",
  "couponCode": null,
  "voucherCode": null
}
```

**Response `200 OK` — cartão aprovado (síncrono):**
```json
{
  "orderId": "ord_01HXYZABC...",
  "status": "PAID",
  "expiresAt": "2026-04-10T20:00:00.000Z",
  "serverTime": "2026-04-10T19:45:00.000Z",
  "payment": {
    "method": "CREDIT_CARD",
    "status": "approved",
    "transactionId": "tx_...",
    "installments": 3,
    "installmentValue": 16500
  },
  "registrations": [
    { "id": "reg_...", "qrCode": "...", "participant": { "id": "...", "name": "..." } }
  ]
}
```

**Response `200 OK` — PIX gerado (assíncrono):**
```json
{
  "orderId": "ord_01HXYZABC...",
  "status": "PENDING",
  "expiresAt": "2026-04-10T20:30:00.000Z",
  "serverTime": "2026-04-10T19:45:00.000Z",
  "payment": {
    "method": "PIX",
    "status": "pending",
    "transactionId": "tx_...",
    "pix": {
      "qrCode": "00020126...",
      "qrCodeBase64": "iVBORw0KG...",
      "expiresAt": "2026-04-10T20:30:00.000Z"
    }
  }
}
```

**⚠️ Extensão do timer com PIX:**

Quando `method === "PIX"` e a cobrança é gerada com sucesso, o servidor **soma 30 minutos ao `expiresAt` atual do pedido** (não seta pra `now() + 30min`, mas sim `expiresAt += 30min`). Exemplo:

- Usuário reservou às `19:30:00` → `expiresAt = 20:00:00`
- Usuário gerou PIX às `19:45:00` (15min restantes) → novo `expiresAt = 20:30:00` (45min restantes)
- Usuário gerou PIX às `19:58:00` (2min restantes) → novo `expiresAt = 20:28:00` (32min restantes)

O `pix.expiresAt` retornado deve ser igual ao novo `order.expiresAt`.

**Erros:**
- `409 ORDER_NOT_PENDING` se o pedido expirou antes da chamada (corrida com o job de expiração). Nesse caso, o frontend expulsa o usuário.
- `402 PAYMENT_REFUSED` se o provedor recusou o cartão. O pedido vai pra `CANCELLED` e o estoque é devolvido.
- `422 BILLING_ADDRESS_REQUIRED` se `PATCH /billing-address` ainda não foi chamado.
- `422 PARTICIPANTS_REQUIRED` se os dados dos participantes estão incompletos.

### 3.7 `GET /orders/{orderId}/payment-status`

Polling da confirmação do PIX. Mesmo comportamento do `GET /payments/registration/{id}/summary` atual, mas agora por `orderId` (mais consistente com o resto do fluxo).

**Response `200 OK`:**
```json
{
  "orderId": "ord_...",
  "status": "PAID",
  "payment": {
    "method": "PIX",
    "status": "approved",
    "paidAt": "2026-04-10T20:12:34.000Z"
  }
}
```

O frontend faz polling a cada 5s. Quando `status === "PAID"` ou `status === "CANCELLED"`, para o polling e reage.

---

## 4. Job de expiração

Duas implementações possíveis, **em ordem de preferência**:

### 4.1 Recomendado — Delayed job por pedido (BullMQ / Redis ZSET / SQS delay)

Ao criar o pedido em `/reserve`, agendar **um job único** com delay calculado pra disparar em `expiresAt`:

```ts
// pseudo-código com BullMQ
await expirationQueue.add(
  'expire-order',
  { orderId: order.id },
  {
    delay: expiresAt.getTime() - Date.now(),
    jobId: `expire-${order.id}`, // idempotência
  }
);
```

Quando o pedido é pago antes da hora, remove o job (`queue.remove(jobId)`). Quando o PIX estende o timer, remove e re-agenda com novo delay.

**Vantagens:** latência de cancelamento ≈ 0s, zero scan de tabela, escala linearmente.

### 4.2 Fallback — Cron scan

Se não houver queue disponível, rodar cron a cada **30s** que busca:

```sql
UPDATE orders
SET status = 'CANCELLED',
    cancelled_at = NOW(),
    cancelled_reason = 'EXPIRED'
WHERE status = 'PENDING'
  AND expires_at <= NOW()
RETURNING id, ...;
```

e aplica o rollback de estoque em batch.

**Requer índice composto obrigatório** em `orders(status, expires_at)` pra não fazer full scan.

### Regras comuns às duas abordagens

Em ambos os casos, a operação de cancelamento deve, **em uma única transação**:

1. Mudar `status` pra `CANCELLED` com `UPDATE ... WHERE id = ? AND status = 'PENDING'` (guarda contra race com pagamento que chegou no último segundo — se `UPDATE` afetar 0 rows, abortar sem devolver estoque).
2. Devolver `quantity` pro `batch.availableQuantity` de cada ticket do pedido.
3. Gravar `cancelledAt = now()` e `cancelledReason = 'EXPIRED'`.
4. Se houver cobrança PIX pendente no provedor, chamar API do provedor pra cancelá-la (evita pagamento tardio).
5. Emitir evento `order.cancelled` no event bus pra invalidar caches e disparar notificações.

---

## 5. Sincronização de tempo (drift)

O relógio do navegador não é confiável. A estratégia é:

1. Toda resposta que inclui `expiresAt` também inclui `serverTime` (now do servidor).
2. No momento da resposta, o frontend calcula:
   ```
   offset = serverTime - clientNow
   ```
3. O countdown exibido é:
   ```
   remaining = expiresAt - (clientNow + offset)
   ```
4. **Sem polling periódico.** O frontend só chama `GET /orders/{orderId}` em eventos explícitos:
   - Ao montar cada step (`informacoes`, `produtos`, `pagamento`) — rehidrata timer e checa se ainda está `PENDING`.
   - Ao clicar em "Avançar" entre steps — antes de qualquer PATCH, confirma que o pedido segue vivo.
   - Ao voltar pro app via `visibilitychange` (usuário troca de aba e volta) — re-sincroniza.
   - Ao reload da página.

Entre esses pontos, o countdown roda 100% client-side com o offset calculado. Se o timer zerar enquanto o usuário está parado em um step, o frontend dispara `GET /orders/{orderId}` **nesse momento** pra confirmar e redirecionar.

---

## 6. Resumo do fluxo no frontend

```
[ingressos]
   │  usuário escolhe quantidades e clica "Avançar"
   │
   ▼
POST /orders/reserve ────▶ { orderId, expiresAt }
   │
   │  frontend salva { orderId, expiresAt } no CheckoutTimerContext
   │  countdown inicia
   │
   ▼
[informacoes]  ◀──── timer visível no header ────▶  [produtos]
   │  PATCH /participants (ao clicar "Avançar")         │  PATCH /products (ao clicar "Avançar")
   │                                                     │
   └────────────────────────┬────────────────────────────┘
                            ▼
                      [pagamento]
                            │
                            │  usuário preenche endereço
                            ▼
              PATCH /orders/{id}/billing-address
                            │
                            │  usuário escolhe método
                            ▼
                POST /orders/{id}/pay
                            │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
         ▼                  ▼                  ▼
       PAID              PENDING            CANCELLED
      (cartão)         (PIX gerado,        (cartão
                        timer +30min)       recusado)
                            │
                            ▼
                GET /orders/{id}/payment-status
                   (polling até PAID ou
                    timer expirar → CANCELLED)
```

Quando o timer zera em qualquer etapa (informacoes, produtos, pagamento):
- O frontend chama `GET /orders/{id}` pra confirmar que foi cancelado.
- Redireciona pra `/events/{slug}` com toast `"Tempo esgotado — sua reserva foi liberada"`.

Se o usuário recarregar a página em qualquer etapa:
- O frontend lê `orderId` do localStorage (chave `checkout_order_{eventId}`).
- Chama `GET /orders/{orderId}` pra rehidratar o estado e o timer.
- Se `status !== 'PENDING'`, limpa o localStorage e volta pra `/events/{slug}`.

---

## 7. Requisitos de segurança (não negociáveis)

Os itens abaixo **não são opcionais**. Se algum não for implementado, o checkout fica exposto a vulnerabilidades conhecidas.

### 7.1 Anti-IDOR (Insecure Direct Object Reference)
Toda rota que recebe `{orderId}` na URL valida `order.userId === req.user.id` **antes** de qualquer query/mutação. Falha de match retorna `404 ORDER_NOT_FOUND` (não `403`, pra não confirmar existência). Testar com integration test que tenta acessar pedido de outro user.

### 7.2 Idempotência do `POST /pay`
Header `Idempotency-Key` obrigatório (UUID v4 gerado pelo cliente). Servidor armazena resposta em Redis por 24h e replica ela em retries. Ver seção 3.6.

### 7.3 Verificação de assinatura do webhook PIX
O endpoint `POST /webhooks/pix` (ou o nome que o provedor usar) **precisa** verificar a assinatura HMAC do provedor antes de processar o corpo. Pseudo-código:

```ts
const signature = req.headers['x-provider-signature'];
const expected = hmacSha256(rawBody, WEBHOOK_SECRET);
if (!constantTimeEqual(signature, expected)) {
  return res.status(401).send();
}
```

Sem isso, qualquer um na internet consegue chamar o webhook e marcar pedidos como pagos. Usar `crypto.timingSafeEqual` (Node) pra evitar timing attacks.

### 7.4 Rate limiting no `/reserve`
Token bucket em Redis: **5 reservas por minuto por userId**. Resposta `429 RATE_LIMIT_EXCEEDED` com header `Retry-After`. Evita segurar estoque de vários eventos ao mesmo tempo.

### 7.5 Cap de PENDING concorrentes
Máximo **3 pedidos `PENDING`** por `userId` no sistema inteiro. Query rápida: `SELECT COUNT(*) FROM orders WHERE user_id = ? AND status = 'PENDING'`. Resposta `409 TOO_MANY_PENDING_ORDERS`.

### 7.6 Transação atômica de pagamento aprovado
Detalhado em 3.6. Cobrança no provedor + criação de `Registrations` + transição `PAID` precisam ser atômicos. Se qualquer passo depois da cobrança falhar, compensação obrigatória (estorno + log + `cancelledReason = 'PAYMENT_RECONCILIATION_FAILED'`).

### 7.7 Grace period do webhook PIX pós-expiração
Ver seção 2. Se webhook chega até **2 minutos** depois de `expiresAt`, honrar o pagamento (`PENDING → PAID`). Fora disso, estornar a cobrança no provedor e manter `CANCELLED`. Essa regra precisa estar testada.

### 7.8 Validação de ownership no webhook também
Quando o webhook chega, tem que verificar que `webhookBody.orderId` existe, está `PENDING` (ou dentro do grace), e pertence ao usuário referenciado no metadata da cobrança do provedor. Nunca confiar cegamente no `orderId` vindo do body.

---

## 8. Requisitos de performance

### 8.1 Delayed job por pedido (preferido) vs cron scan
Ver 4.1 vs 4.2. Delayed job elimina scan da tabela e reduz latência de cancelamento a quase zero.

### 8.2 Índice composto obrigatório
```sql
CREATE INDEX orders_pending_expires_idx
  ON orders (expires_at)
  WHERE status = 'PENDING';
```

Índice parcial é melhor que composto aqui porque a maioria dos pedidos vai estar em `PAID`/`CANCELLED` e não precisa entrar no índice. Se o banco não suportar índice parcial, usar composto `(status, expires_at)`.

Também:
```sql
CREATE INDEX orders_user_pending_idx
  ON orders (user_id)
  WHERE status = 'PENDING';
```

pra acelerar o cap de PENDING concorrentes (seção 7.5).

### 8.3 Push real-time de status do PIX (opcional, fase 2)
O frontend polla `GET /orders/{id}/payment-status` a cada 5s enquanto o modal do PIX está aberto. Em escala, isso vira ~360 requests/hora por usuário com PIX pendente. Melhorias possíveis:

- **SSE** (`GET /orders/{id}/payment-status/stream`) — conexão longa, o servidor empurra o evento quando o webhook chega. Simples de implementar, funciona em HTTP/2.
- **WebSocket** — mais complexo, só vale se já houver infra de WS no projeto.

Enquanto não tem, o polling de 5s é aceitável.

### 8.4 Event bus
Emitir em todas as transições de status:
- `order.reserved` — após `/reserve` bem-sucedido
- `order.paid` — após transição `PAID`
- `order.cancelled` — após transição `CANCELLED` (com reason)

Consumidores: invalidação de cache do evento (availableQuantity mudou), email de confirmação, métricas, analytics. Desacopla o endpoint de pagamento dessas responsabilidades.

---

## 9. Infraestrutura necessária no backend

Antes de começar a implementação, garantir que o stack tem tudo isso disponível:

### 9.1 Redis (obrigatório)
- Armazenamento do cache de `Idempotency-Key` (TTL 24h)
- Token bucket do rate limiting
- (Recomendado) Backing store do BullMQ pro delayed job de expiração

Se ainda não existe no projeto, provisionar **antes** de começar. Sem Redis não dá pra fazer idempotência nem rate limit direito.

### 9.2 Queue system (recomendado)
- **BullMQ** (Node) ou equivalente do stack do backend.
- Usado pra: delayed job de expiração (9.3), webhooks, envio de emails pós-pagamento.
- Fila separada `expiration-queue` com workers dedicados.

### 9.3 Scheduler / delayed job runner
Se não for usar queue: `pg_cron` (PostgreSQL) ou cron do SO rodando worker a cada 30s fazendo o scan descrito em 4.2. Documentar o trade-off: **pedido cancelado até 30s depois do `expiresAt`**.

### 9.4 Webhook endpoint do PIX
- URL pública dedicada (`POST /webhooks/pix`).
- Verificação de assinatura HMAC (seção 7.3).
- Idempotência: processar mesmo `webhookId` duas vezes não pode duplicar nada.
- **Responder 200 rápido** e processar em background (queue) — provedores dão timeout agressivo (5s). Responder primeiro, validar e processar depois.

### 9.5 Tabelas/colunas novas em `orders`
```sql
ALTER TABLE orders
  ADD COLUMN reserved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN expires_at       TIMESTAMPTZ NOT NULL,
  ADD COLUMN cancelled_at     TIMESTAMPTZ,
  ADD COLUMN cancelled_reason TEXT,
  ADD COLUMN idempotency_key  TEXT;
```

`cancelled_reason` enum sugerido: `'EXPIRED' | 'PAYMENT_REFUSED' | 'PAYMENT_RECONCILIATION_FAILED' | 'USER_CANCELLED'` (último não é usado no fluxo atual, mas fica aberto pra futuro).

### 9.6 Tabela/coluna pra `idempotency_keys` (cache)
Se não usar Redis pra isso:
```sql
CREATE TABLE idempotency_keys (
  key             TEXT PRIMARY KEY,
  user_id         UUID NOT NULL,
  order_id        UUID NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INT NOT NULL,
  response_body   JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);
```

Job separado limpa entradas vencidas. Redis é mais simples.

### 9.7 Monitoramento / observabilidade
Métricas mínimas a expor (Prometheus, Datadog, o que for):
- `orders_reserved_total` (counter, por evento)
- `orders_cancelled_total{reason}` (counter)
- `orders_paid_total{method}` (counter)
- `orders_pending_gauge` (gauge instantâneo)
- `order_reserve_duration_seconds` (histograma)
- `order_pay_duration_seconds` (histograma)
- `payment_reconciliation_failures_total` (counter — alerta obrigatório em qualquer valor > 0)

Alertas:
- Qualquer `PAYMENT_RECONCILIATION_FAILED` → página o oncall.
- `orders_pending_gauge` subindo muito → job de expiração pode estar travado.
- Taxa de `BATCH_SOLD_OUT` alta → indicativo de concorrência saudável ou evento popular; não é alerta mas serve pra analytics.

### 9.8 Variáveis de ambiente novas
```
RESERVATION_TTL_MINUTES=30
PIX_EXTENSION_MINUTES=30
PIX_WEBHOOK_GRACE_MINUTES=2
PENDING_ORDERS_CAP_PER_USER=3
RESERVE_RATE_LIMIT_PER_MINUTE=5
IDEMPOTENCY_TTL_HOURS=24
PIX_WEBHOOK_SECRET=<secret>
```

Tudo configurável — duração do timer e extensão do PIX não podem ser hardcoded.

---

## 10. Checklist de implementação (backend)

**Infra (seção 9):**
- [ ] Redis provisionado e acessível
- [ ] Queue system (BullMQ ou equivalente) configurado, fila `expiration-queue` criada
- [ ] Variáveis de ambiente da seção 9.8 definidas
- [ ] Webhook endpoint público com URL fixa

**Banco de dados:**
- [ ] Migration adicionando `reserved_at`, `expires_at`, `cancelled_at`, `cancelled_reason`, `idempotency_key` em `orders`
- [ ] Índice parcial `orders_pending_expires_idx` (seção 8.2)
- [ ] Índice parcial `orders_user_pending_idx` (seção 8.2)
- [ ] Tabela `idempotency_keys` (se não usar Redis)

**Endpoints (seção 3):**
- [ ] `POST /orders/reserve` — atômico, idempotente por (userId, eventId), respeita cap e rate limit
- [ ] `GET /orders/{id}` — com ownership check
- [ ] `PATCH /orders/{id}/participants` — com ownership check e validação
- [ ] `PATCH /orders/{id}/products` — com ownership check
- [ ] `PATCH /orders/{id}/billing-address` — com ownership check
- [ ] `POST /orders/{id}/pay` — com `Idempotency-Key` obrigatório e compensação de falhas
- [ ] `GET /orders/{id}/payment-status` — com ownership check
- [ ] Todas as respostas incluem `serverTime`

**Segurança (seção 7):**
- [ ] Ownership check em toda rota `/orders/{id}` (testado com integration test IDOR)
- [ ] `Idempotency-Key` obrigatório no `/pay`, cache 24h em Redis
- [ ] Verificação HMAC do webhook PIX (`crypto.timingSafeEqual`)
- [ ] Rate limit 5/min no `/reserve`
- [ ] Cap de 3 PENDING por user
- [ ] Transação atômica + compensação no `/pay`
- [ ] Grace de 2min no webhook PIX pós-expiração
- [ ] Webhook verifica ownership cruzada (metadata do provedor bate com `order.userId`)

**Lógica de negócio:**
- [ ] Decremento atômico de `batch.availableQuantity` (`UPDATE ... WHERE availableQuantity >= ?`)
- [ ] `GET /events/{id}` mostra `availableQuantity` já descontando reservas `PENDING`
- [ ] `PIX → expiresAt += 30min` (aditivo, não reset)
- [ ] Delayed job de expiração agendado no `/reserve`, removido no `/pay`, re-agendado no PIX
- [ ] Evento PIX cancela cobrança no provedor quando pedido expira

**Observabilidade (seção 9.7):**
- [ ] Métricas da seção 9.7 expostas
- [ ] Alerta de `PAYMENT_RECONCILIATION_FAILED` > 0
- [ ] Alerta de `orders_pending_gauge` anormal

**Testes:**
- [ ] Concorrência: dois usuários reservando o último ingresso — um `201`, um `409 BATCH_SOLD_OUT`
- [ ] Concorrência: pagamento + expiração no mesmo segundo — exatamente um dos dois vence
- [ ] IDOR: user A tenta ler/alterar pedido do user B — `404` em todos os endpoints
- [ ] Idempotência: mesmo `Idempotency-Key` duas vezes — cobrança única, resposta idêntica
- [ ] Idempotência: mesmo key com body diferente — `422`
- [ ] Webhook com assinatura inválida — `401`
- [ ] Webhook após expiração dentro do grace — `PAID`
- [ ] Webhook após expiração fora do grace — `CANCELLED` + estorno
- [ ] Rate limit: 6 reservas em 1min — 6ª retorna `429`
- [ ] Cap PENDING: 4 pedidos simultâneos — 4º retorna `409 TOO_MANY_PENDING_ORDERS`
- [ ] PIX gera cobrança → `expiresAt` é `anterior + 30min`, não `now + 30min`

---

## 11. Decisões tomadas (pra referência futura)

| Decisão                                                    | Escolha                                                       | Motivo                                                                                  |
|------------------------------------------------------------|---------------------------------------------------------------|------------------------------------------------------------------------------------------|
| Duração da reserva                                         | 30 minutos                                                    | Tempo confortável pra preencher dados sem segurar estoque demais                         |
| Pedido é deletado ao desistir?                             | Não — só transita pra `CANCELLED`                             | Auditoria, métricas de abandono, reconciliação com provedor de pagamento                 |
| Quem autoriza a expiração?                                 | Servidor (job), não o frontend                                | Fechar aba, cair a internet ou matar o processo não pode segurar estoque indefinidamente |
| Extensão do PIX é aditiva ou reset?                        | Aditiva (`expiresAt += 30min`)                                | Usuário que gerou PIX faltando 2min fica com 32min, não só 30min                         |
| Valores monetários                                         | Inteiros em centavos                                          | Evitar erros de ponto flutuante                                                          |
| Onde fica o endereço de cobrança                           | Step dentro de `pagamento` (como hoje), via `PATCH` próprio   | Minimizar mudanças no fluxo visual atual                                                 |
| Autosave dos dados nos steps                               | Não — um único `PATCH` ao clicar "Avançar"                    | Menos tráfego, menos carga no servidor; dados de rascunho ficam só no localStorage       |
| Polling periódico do `GET /orders/{id}`                    | Não — só em eventos (mount, avançar, visibilitychange, reload)| Passivo: reduz carga no servidor, o timer client-side é suficiente entre checkpoints     |
