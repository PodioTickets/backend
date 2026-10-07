/* eslint-disable @typescript-eslint/no-explicit-any */
import { Prisma } from '@prisma/client';

/**
 * Helpers ATÔMICOS de reserva de USO de cupom (limite por contagem — `maxUsage`).
 *
 * Problema que resolvem: o `usageCount` do cupom só era incrementado no finalize
 * (pagamento confirmado), de forma atômica com cap. Entre aplicar e pagar, o cupom NÃO
 * ficava reservado, então N carrinhos concorrentes liam o mesmo `maxUsage − usageCount`,
 * todos travavam o desconto no `finalAmount` e COBRAVAM o cliente já com desconto. No
 * finalize o cap (LEAST) engolia o excesso silenciosamente → na prática mais vendas com
 * desconto do que o `maxUsage` permitia. É o mesmo furo do voucher (uso único), agora na
 * dimensão de CONTAGEM.
 *
 * Solução (espelha a reserva do voucher, mas para um contador): cada pedido PENDING que
 * detém o cupom RESERVA N unidades em `Order.couponReservedUnits`. A disponibilidade real é
 *
 *     maxUsage − usageCount − SUM(couponReservedUnits dos OUTROS pedidos PENDING não-expirados)
 *
 * O claim faz tudo num ÚNICO statement: trava a linha do cupom (`FOR UPDATE OF c`) para
 * serializar claims concorrentes do MESMO cupom, recomputa a SUM já enxergando as reservas
 * commitadas e grava `min(desejado, disponível)` no pedido. Como a reserva vive na linha do
 * próprio pedido, o release é AUTOMÁTICO: ao sair de PENDING (PAID/CANCELLED/REFUNDED) ou
 * quando `expiresAt` vence, o pedido some da SUM — sem release explícito, sem drift, sem cron
 * de reconcile. Mesma filosofia do `reservedUntil` do voucher.
 *
 * O claim grava também `couponId = $couponId` ATOMICAMENTE com as unidades: assim, no
 * instante em que `couponReservedUnits = N` fica visível, o vínculo com o cupom também
 * está — fechando a janela em que uma SUM concorrente veria as unidades sem o couponId e
 * sobre-concederia.
 *
 * Vive aqui (util neutro, sem deps de framework) para que `OrdersService` (aplicação no
 * checkout) e `OrderFinalizationService` (consumo no pagamento) reusem a MESMA regra sem
 * criar ciclo de módulo — mesmo padrão de `coupon-eligibility.util.ts` e
 * `voucher-reservation.util.ts`. Recebe um client Prisma (tx ou normal): por ser um único
 * statement, é atômico mesmo em autocommit — o `FOR UPDATE` serializa via lock de linha.
 */

/**
 * Reserva para `orderId` até `desiredUnits` unidades do cupom, RESPEITANDO o limite restante
 * (committed + reservado por outros pedidos ativos). Retorna quantas unidades foram de fato
 * concedidas (`granted`): `min(desiredUnits, disponível)`, nunca negativo.
 *
 * - `granted === desiredUnits` → reserva integral (caller aplica o desconto pleno).
 * - `0 < granted < desiredUnits` → reserva PARCIAL (caller aplica nas N unidades mais caras —
 *   comportamento já existente do "remaining" para cupons DISCOUNT/AGE).
 * - `granted === 0` → cupom esgotado (caller rejeita suavemente / não aplica).
 *
 * `desiredUnits <= 0` libera a reserva deste pedido (grava 0) e retorna 0 — útil ao remover
 * o cupom. Idempotente e seguro sob corrida: como só REDUZ a reserva, nunca sobre-concede.
 *
 * IMPORTANTE: o claim também grava `couponId = $couponId` no pedido (vínculo atômico). Em
 * `desiredUnits <= 0` o `couponId` NÃO é tocado — quem remove o cupom decide o couponId.
 */
/** Posição do cupom no pedido: `primary` = couponId; `auto` = autoCouponId (acúmulo). */
export type CouponSlot = 'primary' | 'auto';

/**
 * SUM das unidades do cupom reservadas por pedidos PENDING não-expirados, nas DUAS posições
 * do pedido (couponId e autoCouponId do acúmulo). `excludeOrderId` tira o próprio pedido.
 */
function reservedUnitsSql(couponId: string, excludeOrderId?: string): Prisma.Sql {
  return Prisma.sql`COALESCE((
    SELECT SUM(
      CASE WHEN o2."couponId" = ${couponId}::uuid THEN COALESCE(o2."couponReservedUnits", 0) ELSE 0 END +
      CASE WHEN o2."autoCouponId" = ${couponId}::uuid THEN COALESCE(o2."autoCouponReservedUnits", 0) ELSE 0 END
    )::int
    FROM "Order" o2
    WHERE (o2."couponId" = ${couponId}::uuid OR o2."autoCouponId" = ${couponId}::uuid)
      AND o2."status" = 'PENDING'
      AND o2."expiresAt" > NOW()
      ${excludeOrderId ? Prisma.sql`AND o2.id <> ${excludeOrderId}::uuid` : Prisma.empty}
  ), 0)`;
}

export async function claimCouponUnits(
  client: any,
  couponId: string,
  orderId: string,
  desiredUnits: number,
  slot: CouponSlot = 'primary',
): Promise<number> {
  if (!Number.isFinite(desiredUnits) || desiredUnits <= 0) {
    await releaseCouponByOrder(client, orderId, slot);
    return 0;
  }

  const want = Math.floor(desiredUnits);
  // maxUsage NULL = ILIMITADO: concede o desejado integralmente. Sem o CASE, o
  // COALESCE(maxUsage, want) usava want como teto e subtraia usageCount, entao apos o 1o
  // uso (usageCount >= want) o cupom ilimitado zerava (esgotado indevido).
  const sub = Prisma.sql`
      SELECT (CASE
        WHEN c."maxUsage" IS NULL THEN ${want}::int
        ELSE GREATEST(0, LEAST(
          ${want}::int,
          c."maxUsage" - c."usageCount" - ${reservedUnitsSql(couponId, orderId)}
        ))
      END) AS granted
      FROM "Coupon" c
      WHERE c.id = ${couponId}::uuid
      FOR UPDATE OF c`;
  // Vincula o cupom ATOMICAMENTE com as unidades só quando há concessão (granted > 0):
  // assim a SUM concorrente nunca vê unidades sem o vínculo. Em granted = 0 (esgotado)
  // preserva o vínculo atual — o caller decide não aplicar e persiste o vínculo final.
  // Nome de coluna não vira parâmetro → um statement por posição.
  const rows: any[] = slot === 'auto'
    ? await client.$queryRaw`
      UPDATE "Order" o
      SET "autoCouponReservedUnits" = sub.granted,
          "autoCouponId" = CASE WHEN sub.granted > 0 THEN ${couponId}::uuid ELSE o."autoCouponId" END,
          "updatedAt" = NOW()
      FROM (${sub}) sub
      WHERE o.id = ${orderId}::uuid
      RETURNING o."autoCouponReservedUnits" AS granted`
    : await client.$queryRaw`
      UPDATE "Order" o
      SET "couponReservedUnits" = sub.granted,
          "couponId" = CASE WHEN sub.granted > 0 THEN ${couponId}::uuid ELSE o."couponId" END,
          "updatedAt" = NOW()
      FROM (${sub}) sub
      WHERE o.id = ${orderId}::uuid
      RETURNING o."couponReservedUnits" AS granted`;
  return rows.length > 0 ? Number(rows[0].granted) : 0;
}

/**
 * Soma (read-only) as unidades de cupom RESERVADAS por pedidos PENDING não-expirados
 * — TODOS os pedidos (sem excluir nenhum), porque o preview do link é anônimo/sem
 * pedido próprio. Usado para esconder o cupom no preview quando o limite já foi
 * atingido considerando vendas (`usageCount`) + reservas ativas. Espelha a SUM do
 * `claimCouponUnits`. Usa o índice `@@index([couponId, status])`.
 *
 * Prefira o client de ESCRITA (primário) para refletir uma reserva recém-feita sem
 * lag de réplica — o cenário (Comprador 2 logo após o Comprador 1 reservar) é
 * sensível ao tempo. A imposição real continua no `patchCoupon` (row-lock).
 */
export async function sumActiveCouponReservations(
  client: any,
  couponId: string,
): Promise<number> {
  const rows: any[] = await client.$queryRaw`SELECT ${reservedUnitsSql(couponId)} AS reserved`;
  return rows.length > 0 ? Number(rows[0].reserved) : 0;
}

/**
 * Libera a reserva de cupom que `orderId` detém (grava 0). Não toca `couponId` — o caller
 * decide se também desvincula. Idempotente. Usado ao remover/trocar cupom no PENDING; o
 * release por término de pedido (PAID/CANCELLED/expirado) é automático (sai da SUM).
 */
export async function releaseCouponByOrder(
  client: any,
  orderId: string,
  slot: CouponSlot = 'primary',
): Promise<void> {
  if (slot === 'auto') {
    await client.$executeRaw`
      UPDATE "Order"
      SET "autoCouponReservedUnits" = 0, "updatedAt" = NOW()
      WHERE id = ${orderId}::uuid
        AND "autoCouponReservedUnits" IS NOT NULL
        AND "autoCouponReservedUnits" <> 0
    `;
    return;
  }
  await client.$executeRaw`
    UPDATE "Order"
    SET "couponReservedUnits" = 0, "updatedAt" = NOW()
    WHERE id = ${orderId}::uuid
      AND "couponReservedUnits" IS NOT NULL
      AND "couponReservedUnits" <> 0
  `;
}
