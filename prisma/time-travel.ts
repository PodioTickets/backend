/**
 * time-travel.ts
 *
 * Shifts paymentDate on all PAID payments for an event by N days into the past.
 * Makes retention windows expire without waiting real time.
 *
 * Usage:
 *   pnpm ts-node --project tsconfig.node.json prisma/time-travel.ts <eventId|slug> <days>
 *   pnpm ts-node --project tsconfig.node.json prisma/time-travel.ts <eventId|slug> <days> --dry-run
 *   pnpm ts-node --project tsconfig.node.json prisma/time-travel.ts <eventId|slug> --reset
 *
 * Examples:
 *   # Simulate 32 days passed → CC à vista leaves aguardandoLiberacao
 *   pnpm time-travel abc123 32
 *
 *   # Simulate 60 days → installment month 1 due date also passes
 *   pnpm time-travel abc123 60
 *
 *   # Undo: restore original dates (saved in payment metadata.timeTravelOriginalDate)
 *   pnpm time-travel abc123 --reset
 */

import { PrismaClient, PaymentStatus } from '@prisma/client';

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESET = args.includes('--reset');
const eventArg = args.find((a) => !a.startsWith('--')) ?? null;
const daysArg = args.find((a) => /^\d+$/.test(a)) ?? null;
const days = daysArg ? parseInt(daysArg, 10) : 0;

function shiftDate(date: Date, daysBack: number): Date {
  return new Date(date.getTime() - daysBack * 24 * 60 * 60 * 1000);
}

async function main() {
  if (!eventArg) {
    console.error('Usage: time-travel <eventId|slug> <days> [--dry-run]');
    console.error('       time-travel <eventId|slug> --reset');
    process.exit(1);
  }

  if (!RESET && days <= 0) {
    console.error('Provide a positive number of days, e.g.: time-travel <eventId> 32');
    process.exit(1);
  }

  // ── Resolve event ────────────────────────────────────────────────────────

  const event = await prisma.event.findFirst({
    where: { OR: [{ id: eventArg }, { slug: eventArg }] },
    select: { id: true, name: true },
  });

  if (!event) {
    console.error(`Event "${eventArg}" not found.`);
    process.exit(1);
  }

  // ── Load PAID payments for this event ─────────────────────────────────────

  const payments = await prisma.payment.findMany({
    where: {
      status: PaymentStatus.PAID,
      order: { eventId: event.id },
    },
    select: {
      id: true,
      paymentDate: true,
      metadata: true,
    },
  });

  if (payments.length === 0) {
    console.log(`No PAID payments found for event "${event.name}".`);
    return;
  }

  const action = RESET ? 'Resetting' : `Shifting ${days} days back`;
  console.log(`\nevent : ${event.name}`);
  console.log(`action: ${action}  ${DRY_RUN ? '[DRY RUN]' : ''}`);
  console.log(`payments: ${payments.length}\n`);

  let changed = 0;
  let skipped = 0;

  for (const p of payments) {
    if (!p.paymentDate) {
      console.log(`  SKIP  ${p.id} — no paymentDate`);
      skipped++;
      continue;
    }

    const meta = (p.metadata ?? {}) as Record<string, any>;

    if (RESET) {
      const original = meta.timeTravelOriginalDate;
      if (!original) {
        console.log(`  SKIP  ${p.id} — no saved original date`);
        skipped++;
        continue;
      }

      const restored = new Date(original);
      if (DRY_RUN) {
        console.log(`  DRY   ${p.id}  ${p.paymentDate.toISOString()} → ${restored.toISOString()} (restored)`);
      } else {
        const { timeTravelOriginalDate: _, ...cleanMeta } = meta;
        await prisma.payment.update({
          where: { id: p.id },
          data: {
            paymentDate: restored,
            metadata: cleanMeta,
          },
        });
        console.log(`  OK    ${p.id}  → ${restored.toISOString()} (restored)`);
      }
    } else {
      const originalDate = meta.timeTravelOriginalDate
        ? new Date(meta.timeTravelOriginalDate)
        : p.paymentDate;

      const shifted = shiftDate(originalDate, days);

      if (DRY_RUN) {
        console.log(`  DRY   ${p.id}  ${originalDate.toISOString()} → ${shifted.toISOString()}`);
      } else {
        await prisma.payment.update({
          where: { id: p.id },
          data: {
            paymentDate: shifted,
            metadata: {
              ...meta,
              timeTravelOriginalDate: originalDate.toISOString(),
            },
          },
        });
        console.log(`  OK    ${p.id}  → ${shifted.toISOString()}`);
      }
    }

    changed++;
  }

  console.log(`\n${DRY_RUN ? 'Would change' : 'Changed'}: ${changed}  |  Skipped: ${skipped}`);

  if (!DRY_RUN && !RESET) {
    console.log(`\nTo undo: pnpm time-travel ${eventArg} --reset\n`);
  }
}

main()
  .catch((e) => {
    console.error('\n❌', e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
