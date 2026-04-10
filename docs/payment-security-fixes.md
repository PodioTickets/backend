# Correções de Segurança, Performance e Escalabilidade — Sistema de Pagamento

> Revisão realizada em abril de 2026. Cobre dois rounds de auditoria do fluxo de checkout, webhook e processamento de pagamentos.

---

## 1. Falha de serialização não tratada (P2034)

**Problema:** A transação serializable do checkout poderia falhar com `P2034 – Transaction failed due to a write conflict or a deadlock` sob alta concorrência, retornando um erro 500 genérico ao usuário.

**Solução:** Helper `withSerializableRetry` que intercepta `err.code === 'P2034'` e tenta novamente até 3 vezes com backoff exponencial (200 ms, 400 ms, 600 ms). Após esgotar as tentativas, lança `BadRequestException` com mensagem amigável.

**Arquivo:** `src/app/checkout/checkout.service.ts` — método `withSerializableRetry`

---

## 2. Race condition no uso de cupom

**Problema:** A validação do cupom (`usageCount < maxUsage`) era feita fora da transação. Dois checkouts simultâneos podiam passar na validação e ambos incrementar o contador, ultrapassando o limite.

**Solução:** Dentro da transação serializable, antes de incrementar `usageCount`, a query re-lê `usageCount` e `maxUsage` do banco. Se `usageCount >= maxUsage` no momento do commit, a transação é abortada com `BadRequestException`.

**Arquivo:** `src/app/checkout/checkout.service.ts` — seção "Atualizar uso de cupom" em `createRegistrations`

---

## 3. N+1 queries em `createRegistrations`

**Problema:** Para cada participante, eram feitas queries individuais para:
- Buscar o usuário comprador (`user.findUnique` por `userId` — repetido no loop)
- Buscar cada usuário convidado por email (`user.findUnique` — uma query por participante)
- Buscar cada produto (`product.findUnique` — uma query por produto por participante)

**Solução:**
- Buyer user carregado **uma vez** antes do loop
- Todos os emails de participantes buscados em **lote único** com `findMany({ where: { email: { in: [...] } } })`
- Todos os produtos referenciados buscados em **lote único** com `findMany({ where: { id: { in: [...] } } })`
- Resultados armazenados em `Map<email, user>` e `Map<productId, product>` para lookup O(1)

**Arquivo:** `src/app/checkout/checkout.service.ts` — início do loop de participantes em `createRegistrations`

---

## 4. PAN em memória no caminho de sucesso

**Problema:** Em caso de erro no pagamento, o número do cartão era mascarado antes de retornar. Porém, no **caminho de sucesso**, `processPayment` retornava `cardData` com o número completo, CVV e validade, que eram então passados para `createRegistrations` e salvos no metadata do payment.

**Solução:** `processPayment` agora mascara `cardData` antes de retornar em **ambos os caminhos** (sucesso e erro):
- `number` → apenas os 4 últimos dígitos (`***...XXXX`)
- `cvv` → `null`
- `expiry` → `null`
- `holder` e `installments` → mantidos

**Arquivo:** `src/app/checkout/checkout.service.ts` — retorno de `processPayment`

---

## 5. Rate limit no endpoint de checkout

**Problema:** `POST /api/v1/checkout/process` não tinha rate limit específico, permitindo múltiplas tentativas de compra em sequência rápida pelo mesmo usuário.

**Solução:** `@Throttle({ short: { limit: 5, ttl: 60000 } })` — máximo 5 requisições por minuto por usuário.

**Arquivo:** `src/app/checkout/checkout.controller.ts`

---

## 6. Rate limit no endpoint de webhook

**Problema:** `POST /api/v1/payments/webhook` sem rate limit exposto a flood de requisições externas (ex: DDoS via gateway de pagamento falso).

**Solução:** `@Throttle({ short: { limit: 60, ttl: 60000 } })` — máximo 60 requisições por minuto (acomoda volume legítimo da Cielo sem abrir para abuso).

**Arquivo:** `src/app/payments/payments.controller.ts`

---

## 7. `calculatePrices` chamado duas vezes

**Problema:** O fluxo chamava `calculatePrices` duas vezes: uma sem desconto (para calcular o subtotal base) e outra com os descontos aplicados. A segunda chamada refazia todas as queries ao banco (tickets, lotes, produtos) desnecessariamente.

**Solução:** Os preços finais são calculados **aritmeticamente** a partir dos valores já calculados:

```
preDiscountTotal = ticketsSubtotal + productsSubtotal + serviceFee
discountedTotal  = max(0, preDiscountTotal − couponDiscount − voucherDiscount)
pixDiscount      = discountedTotal × 0.05  (apenas se método = PIX)
finalTotal       = discountedTotal − pixDiscount
```

Elimina todas as queries extras da segunda chamada.

**Arquivo:** `src/app/checkout/checkout.service.ts` — step 7 de `processCheckout`

---

## 8. Validação de CPF sem dígito verificador

**Problema:** O campo `cpf` no DTO aceitava qualquer string de 11 dígitos, incluindo valores inválidos como `00000000000` ou `12345678900`.

**Solução:** Decorator customizado `@IsValidCpf()` implementando o algoritmo mod-11 padrão da Receita Federal:
- Verifica comprimento (11 dígitos)
- Rejeita sequências com todos os dígitos iguais (`111...`, `222...`, etc.)
- Valida os dois dígitos verificadores

**Arquivo:** `src/app/checkout/dto/process-checkout.dto.ts`

---

## 9. Circuit breaker para a Cielo

**Problema:** Se a Cielo ficasse indisponível, cada requisição de checkout aguardaria o timeout HTTP completo antes de retornar erro, consumindo threads e degradando toda a aplicação.

**Solução:** State machine simples com variáveis de classe:

| Estado | Condição |
|--------|----------|
| **Fechado** (normal) | Menos de 5 falhas consecutivas |
| **Aberto** (bloqueado) | 5+ falhas → rejeita imediatamente por 30 s |
| **Reset** | Após 30 s, próxima requisição tenta novamente |

Em caso de sucesso, o contador de falhas é zerado. Quando o circuito abre, retorna `BadRequestException` com mensagem indicando o tempo restante para tentar novamente.

**Arquivo:** `src/app/checkout/checkout.service.ts` — propriedades `cieloFailures`, `cieloCircuitOpenUntil` e lógica em `processPayment`

---

## 10. Aviso de rate limiter em memória

**Problema:** O `ConcurrencyLimiterMiddleware` funciona por instância de processo. Em ambientes com múltiplos pods/workers, cada instância tem seu próprio contador, tornando o limite ineficaz distribuído.

**Solução:** Log de `WARN` no construtor quando Redis não está disponível, alertando que o rate limiting é local e não cobre múltiplas instâncias.

**Arquivo:** `src/common/middleware/concurrency-limiter.middleware.ts`

---

## 11. Status de registration incorreto em falha de pagamento

**Problema:** Quando o pagamento falhava (cartão recusado, bloqueado, etc.), a registration era criada com status `PENDING` em vez de `CANCELLED`, aparecendo indevidamente na lista de inscrições pendentes.

**Solução:** Lógica de status em três estados:

```
approved  → CONFIRMED
failed    → CANCELLED
pending   → PENDING  (PIX e Boleto aguardando confirmação via webhook)
```

**Arquivo:** `src/app/checkout/checkout.service.ts` — criação da registration em `createRegistrations`

---

## 12. Idempotência no webhook de pagamento

**Problema:** A Cielo pode enviar o mesmo evento de webhook múltiplas vezes. O código anterior usava `findFirst + if(status === X) return`, criando uma race condition onde dois workers simultâneos podiam processar o mesmo evento.

**Solução:** `updateMany` atômico com condição `status: { not: paymentStatus }`. Apenas o worker que conseguir atualizar (`count === 1`) prossegue com os efeitos colaterais (atualizar registrations). O segundo worker recebe `count === 0` e ignora silenciosamente.

**Arquivo:** `src/app/payments/payments-webhook.service.ts`

---

## 13. Idempotência no checkout (chave de idempotência)

**Problema:** Duplo clique ou retry do frontend poderia criar dois pedidos idênticos.

**Solução:** Campo `idempotencyKey` opcional no DTO. Antes de criar o pedido, verifica se já existe um `Order` com essa chave. Se existir, retorna `BadRequestException` imediatamente. O campo tem índice único no banco (`UNIQUE` com `WHERE idempotencyKey IS NOT NULL`).

**Arquivo:** `src/app/checkout/checkout.service.ts` — step 2 de `processCheckout`; `prisma/schema.prisma` — campo `idempotencyKey` em `Order`

---

## 14. Dados mascarados no paymentResult de erro

**Problema:** Ao criar o `paymentResult` sintético em caso de falha, o número completo do cartão era incluído.

**Solução:** Mesmo padrão do item 4 — apenas últimos 4 dígitos do PAN, `cvv: null`, `expiry: null`.

**Arquivo:** `src/app/checkout/checkout.service.ts` — bloco `catch` do `processPayment` em `processCheckout`

---

## Dependências de infraestrutura recomendadas

| Item | Recomendação |
|------|-------------|
| Rate limiting distribuído | Configurar `REDIS_URL` para que o `ConcurrencyLimiterMiddleware` use Redis em vez de memória local |
| Circuit breaker persistente | Migrar estado do circuit breaker para Redis em ambiente multi-pod |
| Retry de P2034 | Monitorar frequência via logs `warn` — alta frequência indica contenção excessiva de locks |
| Chave de idempotência | O frontend deve gerar um UUID v4 por tentativa de checkout e reusá-lo em retries |
