# Auditoria de Segurança — Correções (junho/2026)

Auditoria completa de backend + frontend (155 agentes, 13 dimensões, cada achado
verificado lendo o código real). Este documento lista **todas as correções**, as
desta entrega e as dos commits anteriores, com a explicação de cada uma.

Severidades: 🔴 CRÍTICO · 🟠 ALTO · 🟡 MÉDIO · 🟢 BAIXO

---

## Correções DESTA entrega

### 🔴 1. Remover colaborador apagava o histórico de saques (sacar 2x)
**Arquivos:** `prisma/schema.prisma`, `prisma/migrations/20260612000000_security_audit_fixes/`, `organizations.service.ts`
`EventWithdrawal.requestedById` tinha `onDelete: Cascade`: remover um membro da
equipe deletava o User inteiro e, em cascata, as linhas de saque que ele havia
solicitado. Como o saldo do repasse é calculado subtraindo essas linhas
(`saldoDisponivel - totalWithdrawn`), o dinheiro **já pago** "voltava" ao saldo e
podia ser sacado de novo (fraude self-service: cria funcionário → funcionário
saca → remove funcionário → saca de novo).
**Fix:** FK mudou para `Restrict` (migration incluída) e o fluxo de remoção
(`removeMember`/`removeMemberAsAdmin`) passou a checar: membro com saques tem a
conta **desativada** (preserva o histórico financeiro) em vez de deletada.

### 🟠 2. Dupla cobrança sem estorno na corrida do pay (ORDER_NOT_PENDING)
**Arquivo:** `orders.service.ts`
A captura na Cielo acontece antes do guard atômico PENDING→PAID. Se o guard
falhasse (duas abas pagando o mesmo pedido, ou cron de expiração cancelando na
janela), o perdedor lançava `ORDER_NOT_PENDING` **sem voidar a captura** — o
cliente ficava cobrado 2x, e a segunda captura era invisível (sem registro local,
o webhook não casa transactionId e a compensação busca por orderId).
**Fix:** o catch agora dispara `cancelPayment` (void) best-effort quando
`ORDER_NOT_PENDING` ocorre após captura bem-sucedida, com log de alerta se o
void falhar.

### 🟠 3. Idempotency-Key global (resposta de outro pedido/usuário)
**Arquivo:** `orders.service.ts`
A chave de idempotência ia crua pro Redis (`orders:idem:<key>`): colisão entre
usuários devolvia o body cacheado de OUTRO pedido (QR PIX/transactionId alheios)
sem cobrar; a mesma chave reusada em dois pedidos pulava a cobrança do segundo.
**Fix:** a chave agora é escopada como `userId:orderId:key` antes de qualquer
uso (cache, lock e gravação).

### 🟠 4. CVV e PAN de cartão em log (violação PCI-DSS)
**Arquivo:** `cielo.service.ts`
Dois logs gravavam dados proibidos: o "payment data prepared" incluía o
`SecurityCode` (CVV) em claro, e o "Request body (masked)" mascarava só o número
do **crédito** — o objeto `DebitCard` inteiro (PAN completo + CVV + validade)
ia sem máscara.
**Fix:** CVV removido de todos os logs; máscara de PAN + remoção de
SecurityCode aplicadas a `CreditCard` **e** `DebitCard`.

### 🟠 5. MerchantKey da Cielo logada em claro a cada transação
**Arquivo:** `cielo.service.ts`
O log "Making request to Cielo" incluía a `MerchantKey` completa — credencial
integral da conta (quem lê o log cria vendas/voids).
**Fix:** `'***masked***'`, igual ao log de PIX que já mascarava.

### 🟠 6. Rotas admin de organizações sem AdminGuard
**Arquivo:** `organizations.controller.ts`
`GET /organizations/admin/organizations` e `GET /organizations/admin/audit-logs`
só exigiam JWT — qualquer usuário comum listava TODAS as organizações (CNPJ,
e-mail, telefone) e todos os audit logs cross-org (PII, IP, old/new values).
**Fix:** `AdminGuard` adicionado às duas rotas.

### 🟠 7. Organizador liberava a própria retenção de 10%
**Arquivo:** `repasse.service.ts`
`assertAdminOrOwner` era idêntico ao `assertAccess` (só permissão financeira do
organizador) — o organizador podia se auto-auditar (`POST /repasse/audit`) e
liberar a retenção pré-repasse, além de completar/cancelar os próprios saques
pelas rotas rotuladas [Admin].
**Fix:** o gate agora exige papel `ADMIN`/`PODIOGO_STAFF` de verdade. O caminho
admin oficial (AdminRepasseController) permanece o mesmo.

### 🟠 8. Upload de PDF público (sem login)
**Arquivo:** `upload.controller.ts`
`POST /upload/pdf` continuava sem guard (o `/image` foi corrigido em commit
anterior) — qualquer pessoa na internet gravava no bucket GCS de produção.
**Fix:** `@UseGuards(JwtAuthGuard)`.

### 🟠 9. Troca/reset de senha não derrubava sessões roubadas
**Arquivos:** `schema.prisma` (+migration), `auth.service.ts`, `jwt.strategy.ts`
Trocar a senha não revogava tokens já emitidos: um access token roubado seguia
válido por até 30 dias mesmo após a vítima trocar a senha.
**Fix:** novo campo `User.passwordChangedAt`, gravado em changePassword /
resetPassword / reset por link. O `JwtStrategy` rejeita qualquer token com
`iat` anterior à última troca (margem de 2s p/ clock skew) — a troca de senha
passou a invalidar todas as sessões antigas.

### 🟡 10. Webhook de estorno/chargeback não cancelava pedido/inscrições
**Arquivos:** `payments-webhook.service.ts`, `payments-chargeback.service.ts`
Quando a Cielo notificava reversão (status 10/11), o webhook só rebaixava o
Payment pra REFUNDED: o pedido ficava PAID, as inscrições CONFIRMED (ingressos
válidos pra sempre), cupom/voucher/estoque não revertiam — e o payment saía do
filtro do cron de chargeback (que só varre PAID). Estado inconsistente
permanente, irreparável até pela UI de estorno.
**Fix:** o webhook agora **delega** reversões ao `processReversal` (tornado
público) do serviço de chargeback — a MESMA reversão completa e idempotente do
cron: Payment→REFUNDED com refundType, Order→CANCELLED, inscrições→CANCELLED,
cupom/voucher/estoque revertidos.

### 🟡 11. Retry de PIX deixava QR antigo pagável (dinheiro órfão)
**Arquivo:** `orders.service.ts`
Pagar de novo um pedido PIX sobrescrevia o transactionId sem voidar a venda
anterior — o QR antigo continuava pagável. Se o cliente pagasse o QR antigo, o
webhook não casava nenhuma linha local (descartado como "idempotente"): dinheiro
capturado, sem ingresso, sem estorno, sem alerta.
**Fix:** void best-effort do QR anterior antes de registrar o novo.

### 🟡 12. patchProducts aceitava produto de OUTRO evento
**Arquivo:** `orders.service.ts`
Faltava validar que o produto pertence ao evento do pedido: dava pra injetar
produto alheio no pedido (entrava no subtotal, na base de desconto, virava
RegistrationProduct e segurava estoque do outro evento).
**Fix:** rejeita com 422 quando `product.eventId !== order.eventId`.

### 🟡 13. /login/admin sem captcha + oráculo de credenciais
**Arquivo:** `auth.controller.ts`
A rota validava a senha de QUALQUER usuário sem Turnstile (brute-force livre,
contornando a proteção do /login) e respondia 401 vs 403 — o 403 confirmava que
a senha estava certa (faltava só o papel), validando credenciais roubadas.
**Fix:** `TurnstileGuard` adicionado (a página de login do admin já envia o
token) e resposta unificada em 401 indistinguível.

### 🟡 14. Login Google sem checar e-mail verificado (account takeover)
**Arquivos:** `google.strategy.ts`, `auth.service.ts`
O vínculo Google→conta local é feito só pelo e-mail. Aceitar e-mail NÃO
verificado pelo Google permitia que um atacante criasse uma conta Google com o
e-mail da vítima (sem confirmar a posse) e assumisse a conta local dela.
**Fix:** os dois fluxos (Passport e troca de code) rejeitam e-mail com
`verified === false`.

### 🟢 15. Códigos de reset com Math.random (previsível)
**Arquivo:** `auth.service.ts`
Os códigos de 6 dígitos de reset de senha/troca de e-mail usavam `Math.random()`
(PRNG previsível) — o 2FA já usava `crypto.randomInt`.
**Fix:** `crypto.randomInt` (CSPRNG) também no `generateCode`.

### 🟢 16. Metadata do webhook gravava o status do payload (forjável)
**Arquivo:** `payments-webhook.service.ts`
A transição usava o status REAL consultado na Cielo, mas o metadata persistia o
do payload — trilha de auditoria podia divergir da transição aplicada.
**Fix:** metadata grava o status consultado (`actualCieloStatus`).

### 🟢 17. Polling PIX duplicava e-mails de confirmação
**Arquivo:** `payments.service.ts`
Quando o webhook vencia a corrida (count=0 na tx), o polling ainda emitia o
WebSocket e reenviava TODOS os e-mails (com PDFs) pro comprador e participantes.
**Fix:** flag `confirmedHere` — só quem finalizou de fato emite/envia.

### 🟢 18. getOrderDetails: 500 em vez de 404
**Arquivo:** `orders.service.ts`
`order.userId` era desreferenciado antes do check de nulo — orderId inexistente
derrubava a rota com TypeError (500 + stack trace).
**Fix:** check de `!order` movido pra antes do primeiro acesso.

---

## Correções de commits ANTERIORES (mesma auditoria)

### 🔴 19. Bypass de MFA — `5eb8414`
O `mfaToken` (emitido após a senha, antes do OTP) era aceito como access token
normal em TODAS as rotas protegidas: atacante com só a senha pulava o segundo
fator por 10 minutos. **Fix:** `JwtStrategy` rejeita tokens com `mfaPending`.

### 🟠 20. Crédito aprovava mas ficava "pendente" no painel — `7cdf77c`
Crédito era só AUTORIZADO (`Capture=false`) e nada chamava a captura: a
autorização expirava sem liquidar e o webhook rebaixava o Payment pra PENDING.
**Fix:** `Capture=true` (auto-captura) + captura defensiva com void em falha +
webhook ignora status intermediários (nunca rebaixa Payment decidido) + Payment
PENDING persistido pra análise antifraude (status 12).

### 🟠 21. ReturnUrl ausente no débito 3DS — `2958263`
A Cielo exige `ReturnUrl` em TODO débito; no fluxo 3DS via MPI ele era omitido
(apontado pelo suporte Cielo). **Fix:** ReturnUrl enviado nos dois fluxos
(junto com `ExternalAuthentication`), com 3 testes de regressão.

### 🟠 22. Assinatura do webhook Cielo comparada errado — `a0d6e6b`
A validação comparava o header com o próprio segredo; o correto é HMAC-SHA256
do payload. **Fix:** HMAC computado e comparado com `timingSafeEqual`;
`CIELO_WEBHOOK_SECRET` virou obrigatório em produção (boot falha sem ele).

### 🟠 23. Upload de imagem público — `a0d6e6b`
`POST /upload/image` não tinha guard nem limite. **Fix:** `JwtAuthGuard` +
limite de 10MB. (O `/pdf` ficou de fora e foi corrigido nesta entrega — item 8.)

### 🟠 24. Tokens legíveis por JavaScript (XSS roubava sessão) — `a3a7557`/`225ba7f`/`041200c` (front)
Tokens iam no body e o front gravava via js-cookie (legível por JS). **Fix:**
migração completa para cookies **httpOnly** emitidos pelo backend, com
superfícies isoladas (admin/organizador/cliente), SameSite=Lax; o front parou
de gerenciar tokens.

### 🟠 25. logout() era no-op — `a0d6e6b`
**Fix:** logout denylista o refresh token (hash em cache com TTL até o exp) e o
refresh consulta a denylist.

### 🟡 26. Cupom DISCOUNT/AGE estourava maxUsage sob concorrência — `a0d6e6b`
**Fix:** cap movido pra dentro do UPDATE atômico via `LEAST`.

### 🟡 27. Estorno chamava a Cielo antes do claim local — `a0d6e6b`
Duas execuções concorrentes disparavam dois voids no gateway. **Fix:** claim
REFUNDED no banco antes da chamada externa.

### 🟡 28. Cupom+voucher acima do total → valores negativos — `a0d6e6b`
**Fix:** desconto total capado no valor pré-desconto.

### 🟡 29. Oversell por leitura de réplica defasada — `a0d6e6b`
Pre-checks de estoque/voucher liam a réplica (podia estar atrasada). **Fix:**
checagens críticas movidas pro write client (o UPDATE atômico segue sendo a
proteção real).

### 🟢 30. csrf_secret com `secure:false` hardcoded — corrigido no refactor de cookies.
### 🟢 31. IPINFO_TOKEN hardcoded no código — removido.
### 🟢 32. SESSION_SECRET vazio em produção — boot agora falha sem ele.

---

## Pendências conhecidas (não corrigidas nesta entrega)

- **Refresh token sem rotação/reuse-detection**: o logout revoga, mas um refresh
  token roubado (sem logout) segue válido até expirar. Mitigado pelo
  `passwordChangedAt` (trocar a senha agora derruba tudo). Fix definitivo =
  modelo `RefreshToken` persistido.
- **Reserve concorrente** pode criar 2 pedidos PENDING do mesmo usuário
  (estoque atômico impede oversell; o sweeper devolve em ~30min) — baixo impacto.
- **Achados de frontend não verificados** pela auditoria automatizada (rodada
  interrompida): stored XSS via descrição de evento (quill), CSP com
  `unsafe-inline`, tokens em query no callback OAuth (fluxo alternativo legado).
  Requerem verificação manual.
- ⚠️ **Deploy**: a migration `20260612000000_security_audit_fixes` precisa rodar
  (`prisma migrate deploy`). Pedidos de crédito antigos presos em "pendente"
  (era pré-captura) não se auto-corrigem — conferir capturas no painel Cielo.
