/**
 * reconcile-orphan-orders.ts
 *
 * Comando one-off (manual) — backfill das INSCRIÇÕES VAZIAS dos pedidos órfãos do bug
 * legado de finalização PIX/3DS (pré 2026-05-28).
 *
 * CONTEXTO
 *   O fluxo antigo de confirmação marcava Registration = CONFIRMED + Payment = PAID, mas
 *   apenas flipava os PLACEHOLDERS vazios (sem participante/ticket/snapshot/qrCode) — nunca
 *   rodava o finalize. Resultado: pedido pago com ingresso quebrado (PDF/QR ruins) e Order
 *   preso em PENDING. A migration `20260529000000_reconcile_paid_orphan_orders` já conserta o
 *   STATUS do Order (fecha o dashboard). Este comando reconstrói as inscrições de verdade.
 *
 * POR QUE NÃO É MIGRATION SQL
 *   Recriar inscrição exige a lógica de `OrderFinalizationService.finalizePaidOrder` (snapshot
 *   do recibo, qrCode, RegistrationTicket/Product, QuestionAnswer, uso de cupom/voucher) — fonte
 *   única em TS. Reescrever em SQL duplicaria a regra. Aqui REUSAMOS o service.
 *
 * O QUE FAZ (por pedido órfão, em transação)
 *   1. Garante Order.status = 'PAID' (self-sufficient, mesmo se a migration ainda não rodou).
 *   2. Deleta os placeholders CONFIRMED vazios (status CONFIRMED + 0 tickets; cascade limpa
 *      filhos eventuais).
 *   3. Chama finalizePaidOrder(tx, orderId) → recria inscrições a partir de pendingParticipants.
 *
 * SEGURANÇA / DECISÕES
 *   - Dry-run por PADRÃO. Só aplica com `--apply`.
 *   - Processa apenas pedidos cujas inscrições CONFIRMED estão TODAS vazias. Pedidos MISTOS
 *     (alguma inscrição já com ticket) são PULADOS com aviso — exigem inspeção manual (evita
 *     duplicar inscrições boas).
 *   - Pedidos sem `pendingParticipants` são PULADOS (não há como reconstruir).
 *   - ⚠️ CUPOM/VOUCHER: finalizePaidOrder (re)aplica o uso (incrementa usageCount / marca USED).
 *     O fluxo legado quebrado NÃO finalizava, então NÃO aplicou — re-rodar aplica 1×. Mesmo
 *     assim, o dry-run lista os pedidos COM cupom/voucher pra você conferir antes de aplicar.
 *
 * USO
 *   pnpm reconcile:orphan-orders --dry-run            # (default) só inspeciona
 *   pnpm reconcile:orphan-orders --apply              # aplica
 *   pnpm reconcile:orphan-orders --apply --event=<id> # restringe a um evento
 */

import { PrismaClient } from '@prisma/client';
import { OrderFinalizationService } from '../src/app/payments/order-finalization.service';
import type { PrismaService } from '../src/prisma/prisma.service';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;
const eventArg = process.argv.find((a) => a.startsWith('--event='));
const EVENT_ID = eventArg ? eventArg.split('=')[1] : null;

// finalizePaidOrder só usa `this.prisma.getReadClient()` (leituras de snapshot); as escritas
// vão todas no `tx`. Um shim mínimo basta — evita subir o AppModule inteiro (cron, redis, etc.).
const prismaShim = {
  getReadClient: () => prisma,
  getWriteClient: () => prisma,
} as unknown as PrismaService;

// Telemetria no-op: script offline de reconciliação não deve gerar eventos de jornada
// (os order.paid daqui seriam retroativos/duplicados — a venda real já aconteceu).
const activityShim = { record: () => {} } as any;

const finalizer = new OrderFinalizationService(prismaShim, activityShim);

async function main() {
  console.log(`\nreconcile-orphan-orders  ${DRY_RUN ? '[DRY RUN]' : '[APPLY]'}${EVENT_ID ? `  event=${EVENT_ID}` : ''}\n`);

  // Candidatos: pagamento PAID + ao menos uma inscrição CONFIRMED sem ticket (placeholder vazio).
  const candidates = await prisma.order.findMany({
    where: {
      payment: { status: 'PAID' },
      registrations: { some: { status: 'CONFIRMED', tickets: { none: {} } } },
      ...(EVENT_ID ? { eventId: EVENT_ID } : {}),
    },
    select: {
      id: true,
      status: true,
      couponId: true,
      voucherId: true,
      pendingParticipants: true,
      registrations: {
        select: { id: true, status: true, _count: { select: { tickets: true } } },
      },
    },
  });

  console.log(`Pedidos candidatos (payment PAID + inscrição CONFIRMED vazia): ${candidates.length}\n`);
  if (candidates.length === 0) {
    console.log('Nada a fazer.\n');
    return;
  }

  let rebuilt = 0;
  let skippedMixed = 0;
  let skippedNoParticipants = 0;
  let createdRegsTotal = 0;

  for (const order of candidates) {
    const confirmed = order.registrations.filter((r) => r.status === 'CONFIRMED');
    const emptyConfirmed = confirmed.filter((r) => r._count.tickets === 0);
    const nonEmptyConfirmed = confirmed.filter((r) => r._count.tickets > 0);

    // Pedido MISTO (alguma inscrição já finalizada) — não mexe; refinalizar duplicaria.
    if (nonEmptyConfirmed.length > 0) {
      console.warn(`  SKIP  order ${order.id} — MISTO (${nonEmptyConfirmed.length} c/ ticket, ${emptyConfirmed.length} vazia) → inspeção manual`);
      skippedMixed++;
      continue;
    }

    const participants = (order.pendingParticipants as any[] | null) ?? [];
    if (participants.length === 0) {
      console.warn(`  SKIP  order ${order.id} — sem pendingParticipants (não há como reconstruir)`);
      skippedNoParticipants++;
      continue;
    }

    const flags = [
      order.couponId ? 'CUPOM' : null,
      order.voucherId ? 'VOUCHER' : null,
      order.status !== 'PAID' ? `status=${order.status}` : null,
    ].filter(Boolean).join(' ');

    if (DRY_RUN) {
      console.log(`  DRY   order ${order.id} → reconstruir ${participants.length} inscrição(ões), apagar ${emptyConfirmed.length} placeholder(s) ${flags ? `[${flags}]` : ''}`);
      rebuilt++;
      continue;
    }

    try {
      const created = await prisma.$transaction(
        async (tx) => {
          // 1. Garante status PAID (idempotente — no-op se já PAID pela migration).
          await tx.order.updateMany({
            where: { id: order.id, status: { not: 'PAID' } },
            data: { status: 'PAID', updatedAt: new Date() },
          });

          // 2. Remove os placeholders CONFIRMED vazios (cascade limpa filhos eventuais).
          await tx.registration.deleteMany({
            where: { id: { in: emptyConfirmed.map((r) => r.id) } },
          });

          // 3. Recria as inscrições de verdade (fonte única).
          const regs = await finalizer.finalizePaidOrder(tx, order.id);
          return regs.length;
        },
        { timeout: 30000, maxWait: 10000 },
      );

      createdRegsTotal += created;
      rebuilt++;
      console.log(`  OK    order ${order.id} → ${created} inscrição(ões) recriada(s) ${flags ? `[${flags}]` : ''}`);
    } catch (e: any) {
      console.error(`  FAIL  order ${order.id} — ${e?.message ?? e}`);
    }
  }

  console.log('\n──────────────────────────────────────────────');
  console.log(`${DRY_RUN ? 'Reconstruiria' : 'Reconstruídos'}: ${rebuilt} pedido(s)`);
  if (!DRY_RUN) console.log(`Inscrições recriadas: ${createdRegsTotal}`);
  console.log(`Pulados (mistos):           ${skippedMixed}`);
  console.log(`Pulados (sem participante): ${skippedNoParticipants}`);
  console.log('──────────────────────────────────────────────\n');
  if (DRY_RUN) console.log('Rode com --apply para aplicar.\n');
}

main()
  .catch((e) => {
    console.error('\n❌', e?.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
