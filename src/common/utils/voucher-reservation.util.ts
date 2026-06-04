/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Helpers ATÔMICOS de reserva de voucher (uso único).
 *
 * Problema que resolvem: o voucher é "1 ingresso grátis, uso único", mas a transição
 * ACTIVE→USED só acontecia no finalize (pagamento). Entre aplicar e pagar, o voucher ficava
 * ACTIVE e podia ser anexado a VÁRIOS pedidos PENDING ao mesmo tempo — e o guard do finalize
 * apenas logava quando o voucher já estava usado, deixando passar a dupla-concessão (sobretudo
 * em PIX/webhook e pedidos R$0 concorrentes).
 *
 * Solução: enquanto um pedido ATIVO detém o voucher, ele fica "reservado" (`reservedByOrderId`).
 * O claim é um UPDATE condicional ÚNICO (sem read-modify-write), portanto seguro sob corrida.
 * `reservedUntil` (= `order.expiresAt`) é rede de segurança: reserva vencida conta como livre,
 * então um carrinho abandonado nunca prende o voucher para sempre, mesmo se algum release falhar.
 *
 * Vivem aqui (util neutro, sem deps de framework) para que tanto `OrdersService` (aplicação)
 * quanto `OrderFinalizationService` (consumo) reusem a MESMA regra sem criar ciclo de módulo —
 * mesmo padrão de `coupon-eligibility.util.ts`. Os callers decidem o controle de fluxo
 * (rejeição suave vs. throw) a partir do boolean retornado.
 *
 * Todos recebem um client Prisma (tx ou cliente normal) e operam via SQL cru por atomicidade.
 */

/**
 * Tenta reservar o voucher para `orderId`. Bem-sucedido (retorna `true`) quando o voucher está
 * ACTIVE e: (a) livre, (b) já reservado por ESTE pedido (idempotente), ou (c) com reserva
 * vencida (`reservedUntil < now()`) — caso em que a reserva é "roubada" do carrinho abandonado.
 * Retorna `false` quando outro pedido ativo detém a reserva (→ caller rejeita suavemente).
 *
 * @param reservedUntil normalmente `order.expiresAt`; expiração da reserva (auto-libera abandono).
 */
export async function claimVoucher(
  client: any,
  voucherId: string,
  orderId: string,
  reservedUntil: Date,
): Promise<boolean> {
  const rows: any[] = await client.$queryRaw`
    UPDATE "Voucher"
    SET "reservedByOrderId" = ${orderId}::uuid,
        "reservedUntil" = ${reservedUntil},
        "updatedAt" = NOW()
    WHERE id = ${voucherId}::uuid
      AND "status" = 'ACTIVE'
      AND (
        "reservedByOrderId" IS NULL
        OR "reservedByOrderId" = ${orderId}::uuid
        OR ("reservedUntil" IS NOT NULL AND "reservedUntil" < NOW())
      )
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Libera QUALQUER reserva que `orderId` detenha (independe do voucherId — útil em cancel/expire,
 * onde só temos o pedido). Não toca em vouchers já USED (esses têm `reservedByOrderId` NULL desde
 * o consumo). Idempotente: zero linhas se o pedido não reservava nada.
 */
export async function releaseVoucherByOrder(client: any, orderId: string): Promise<void> {
  await client.$executeRaw`
    UPDATE "Voucher"
    SET "reservedByOrderId" = NULL,
        "reservedUntil" = NULL,
        "updatedAt" = NOW()
    WHERE "reservedByOrderId" = ${orderId}::uuid
  `;
}

/**
 * Consome o voucher (ACTIVE→USED) no finalize, ESCOPADO à reserva do pedido. Retorna `true` se
 * ESTE pedido venceu o consumo; `false` se o voucher já não estava ACTIVE/reservado por ele
 * (consumido por outro pedido) — caso em que o caller DEVE abortar o finalize (rollback) para
 * não conceder o ingresso grátis duas vezes.
 *
 * Aceita também `reservedByOrderId IS NULL` por robustez: cobre pedidos legados criados antes da
 * reserva (voucher ACTIVE sem reserva) — o primeiro a finalizar consome; o segundo recebe `false`.
 */
export async function tryConsumeVoucher(
  client: any,
  voucherId: string,
  orderId: string,
  userId: string,
): Promise<boolean> {
  const rows: any[] = await client.$queryRaw`
    UPDATE "Voucher"
    SET "status" = 'USED',
        "usedAt" = NOW(),
        "usedBy" = ${userId}::uuid,
        "reservedByOrderId" = NULL,
        "reservedUntil" = NULL,
        "updatedAt" = NOW()
    WHERE id = ${voucherId}::uuid
      AND "status" = 'ACTIVE'
      AND ("reservedByOrderId" = ${orderId}::uuid OR "reservedByOrderId" IS NULL)
    RETURNING id
  `;
  return rows.length > 0;
}
