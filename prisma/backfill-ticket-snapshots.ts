/**
 * backfill-ticket-snapshots.ts
 *
 * One-time script: fills ticketSnapshot on every RegistrationTicket that has none,
 * for orders whose payment is PAID (reservation-flow PIX/Boleto orders confirmed
 * before the webhook backfill was added).
 *
 * Usage:
 *   pnpm ts-node --project tsconfig.node.json prisma/backfill-ticket-snapshots.ts
 *   pnpm ts-node --project tsconfig.node.json prisma/backfill-ticket-snapshots.ts --dry-run
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`\nbackfill-ticket-snapshots  ${DRY_RUN ? '[DRY RUN]' : ''}\n`);

  // Find all RegistrationTickets without a snapshot on PAID orders
  const regTickets = await prisma.registrationTicket.findMany({
    where: {
      ticketSnapshot: { equals: Prisma.JsonNull },
      registration: {
        order: {
          payment: { status: 'PAID' },
        },
      },
    },
    select: {
      id: true,
      ticketId: true,
      batchId: true,
      registration: { select: { orderId: true } },
    },
  });

  console.log(`Found ${regTickets.length} RegistrationTicket(s) without snapshot.\n`);

  if (regTickets.length === 0) {
    console.log('Nothing to do.\n');
    return;
  }

  // Load all tickets needed in one query
  const ticketIds = [...new Set(regTickets.map((rt) => rt.ticketId))];
  const tickets = await prisma.ticket.findMany({
    where: { id: { in: ticketIds } },
    include: {
      category: { select: { id: true, name: true } },
      batches: { select: { id: true, price: true, sortOrder: true } },
    },
  });
  const ticketById = new Map(tickets.map((t) => [t.id, t]));

  let updated = 0;
  let skipped = 0;

  for (const rt of regTickets) {
    const t = ticketById.get(rt.ticketId);
    if (!t) {
      console.warn(`  SKIP  RegistrationTicket ${rt.id} — ticket ${rt.ticketId} not found (soft-deleted?)`);
      skipped++;
      continue;
    }

    const batch = rt.batchId
      ? (t.batches as any[]).find((b) => b.id === rt.batchId) ?? null
      : null;

    const ticketSnapshot = {
      id: t.id,
      name: t.name,
      description: (t as any).description ?? null,
      modality: (t as any).modality ?? null,
      distance: (t as any).distance ?? null,
      distanceUnit: (t as any).distanceUnit ?? null,
      gender: (t as any).gender ?? null,
      ageLimitMin: (t as any).ageLimitMin ?? null,
      ageLimitMax: (t as any).ageLimitMax ?? null,
      category: (t as any).category ?? null,
      batch: batch ? { id: batch.id, price: batch.price } : null,
      products: [],
    };

    if (DRY_RUN) {
      console.log(`  DRY   RegistrationTicket ${rt.id} → ticket "${t.name}" (order ${rt.registration.orderId})`);
    } else {
      await prisma.registrationTicket.update({
        where: { id: rt.id },
        data: { ticketSnapshot },
      });
      console.log(`  OK    RegistrationTicket ${rt.id} → ticket "${t.name}"`);
    }
    updated++;
  }

  console.log(`\n${DRY_RUN ? 'Would update' : 'Updated'}: ${updated}  |  Skipped: ${skipped}\n`);
  if (DRY_RUN) console.log('Run without --dry-run to apply.\n');
}

main()
  .catch((e) => {
    console.error('\n❌', e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
