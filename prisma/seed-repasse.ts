/**
 * seed-repasse.ts
 *
 * Simulates the full payment-to-repasse flow, replicating the exact DB operations
 * that each service performs, so the resulting data is indistinguishable from real usage.
 *
 * Stages reproduced:
 *   1. Checkout  — Order + Payment (PENDING or PAID) + Registration + ticketSnapshot + qrCode
 *   2. Webhook   — PIX/Boleto orders: Payment → PAID, Registrations → CONFIRMED
 *   3. Repasse   — EventWithdrawal PENDING → COMPLETED (admin approves)
 *   4. Audit     — EventAudit (optional --audit flag, releases valorRetido)
 *
 * Scenarios included:
 *   - PIX à vista, recent (< 1d)        → aguardandoLiberacao
 *   - CC à vista, recent (< 31d)         → aguardandoLiberacao
 *   - CC à vista, old (> 31d)            → valorRetido (10%) + saldoDisponivel (90%)
 *   - PIX, old (> 1d)                    → saldoDisponivel
 *   - CC 3x installments                 → parceladosAReceber (future installments)
 *   - CC à vista REFUND                  → deducts from saldoDisponivel
 *   - CC 2x installment REFUND           → deducts parceladosAReceber first
 *   - CC FAILED                          → no bucket (ignored)
 *   - EventWithdrawal COMPLETED + PENDING → reduces saldoParaSaque
 *
 * Usage:
 *   pnpm ts-node --project tsconfig.node.json prisma/seed-repasse.ts [eventId|slug] [--reset] [--audit]
 *
 * Flags:
 *   --reset   Wipe all orders/payments/registrations/withdrawals/audit for the event first
 *   --audit   Create EventAudit record (releases valorRetido into saldoDisponivel)
 */

import {
  PrismaClient,
  PaymentMethod,
  PaymentStatus,
  RegistrationStatus,
  WithdrawalStatus,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const FLAG_RESET = args.includes('--reset');
const FLAG_AUDIT = args.includes('--audit');
const eventArg = args.find((a) => !a.startsWith('--')) ?? null;

// ─── Time helpers ─────────────────────────────────────────────────────────────

function daysAgo(days: number, hours = 0): Date {
  return new Date(Date.now() - (days * 24 + hours) * 60 * 60 * 1000);
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

// ─── Reset ───────────────────────────────────────────────────────────────────

async function resetEvent(eventId: string) {
  console.log('  Resetting event data...');
  await prisma.eventAudit.deleteMany({ where: { eventId } });
  await prisma.eventWithdrawal.deleteMany({ where: { eventId } });
  await prisma.registrationTicket.deleteMany({ where: { registration: { eventId } } });
  await prisma.registrationProduct.deleteMany({ where: { registration: { eventId } } });
  await prisma.questionAnswer.deleteMany({ where: { registration: { eventId } } });
  await prisma.registrationModality.deleteMany({ where: { registration: { eventId } } });
  await prisma.registration.deleteMany({ where: { eventId } });
  await prisma.payment.deleteMany({ where: { order: { eventId } } });
  await prisma.order.deleteMany({ where: { eventId } });
  console.log('  Done.\n');
}

// ─── Seed users ──────────────────────────────────────────────────────────────

async function ensureSeedUsers(count: number): Promise<any[]> {
  const existing = await prisma.user.findMany({
    where: { email: { startsWith: 'repasse.seed+' } },
    take: count,
    orderBy: { createdAt: 'asc' },
  });

  if (existing.length >= count) return existing.slice(0, count);

  const hashed = await bcrypt.hash('Seed@123456', 10);
  const created: any[] = [];
  const firstNames = ['Carlos', 'Ana', 'Pedro', 'Julia', 'Marcos', 'Fernanda', 'Lucas', 'Beatriz', 'Rafael', 'Camila'];
  const lastNames = ['Silva', 'Santos', 'Oliveira', 'Rodrigues', 'Costa', 'Alves', 'Lima', 'Pereira', 'Souza', 'Martins'];

  for (let i = existing.length; i < count; i++) {
    const user = await prisma.user.create({
      data: {
        email: `repasse.seed+${i}@podioticket.test`,
        password: hashed,
        firstName: firstNames[i % firstNames.length],
        lastName: lastNames[i % lastNames.length],
        phone: `119${String(90000000 + i).padStart(8, '0')}`,
        documentNumber: `${String(100000000 + i).padStart(11, '0')}`,
        accountType: 'USER',
        city: 'São Paulo',
        state: 'SP',
        country: 'Brasil',
        acceptedTerms: true,
        acceptedPrivacyPolicy: true,
      },
    });
    created.push(user);
  }

  if (created.length > 0) console.log(`  Created ${created.length} seed users.`);
  return [...existing, ...created];
}

// ─── Stage 1: Checkout ────────────────────────────────────────────────────────
// Replicates checkout.service.ts createRegistrations() logic

interface CheckoutSpec {
  buyer: any;
  ticket: any;
  batch: any;
  method: PaymentMethod;
  /** PAID = CC approved immediately; PENDING = PIX/Boleto awaiting webhook; FAILED = declined */
  paymentStatus: PaymentStatus;
  createdAt: Date;
  installments?: number;
  label: string;
}

async function runCheckout(eventId: string, spec: CheckoutSpec) {
  const { buyer, ticket, batch, method, paymentStatus, createdAt, installments = 1 } = spec;

  // Price calculation (replicating checkout.service.ts calculatePrices)
  const ticketsSubtotal = batch.price; // 1 ticket
  const serviceFee = 0;               // seed keeps it simple
  const pixDiscount = method === PaymentMethod.PIX ? Math.floor(ticketsSubtotal * 0.05) : 0;
  const finalAmount = ticketsSubtotal - pixDiscount;

  // Billing address (required field on Order)
  const billingAddress = {
    billingCountry: 'BR',
    billingPostalCode: '01310-100',
    billingStateUf: 'SP',
    billingStreet: 'Av. Paulista',
    billingNumber: '1000',
    billingComplement: null,
    billingNeighborhood: 'Bela Vista',
    billingCity: 'São Paulo',
  };

  // ── 1. Create Order ──────────────────────────────────────────────────────────
  const order = await prisma.order.create({
    data: {
      userId: buyer.id,
      eventId,
      totalAmount: ticketsSubtotal,
      serviceFee,
      discount: pixDiscount,
      finalAmount,
      ...billingAddress,
      createdAt,
      updatedAt: createdAt,
    },
  });

  // ── 2. Create Payment ────────────────────────────────────────────────────────
  // Metadata mirrors what checkout.service.ts paymentMetadata produces
  const creditCardMeta = method === PaymentMethod.CREDIT_CARD ? {
    last4Digits: '4242',
    brand: 'Visa',
    holder: `${buyer.firstName} ${buyer.lastName}`.toUpperCase(),
    installments,
    installmentValue: Math.round(finalAmount / installments),
  } : null;

  const paymentMetadata: any = {
    creditCard: creditCardMeta,
    pix: method === PaymentMethod.PIX ? {
      qrCode: `SEED-PIX-QR-${order.id}`,
      pixCode: `SEED-PIX-CODE-${order.id}`,
      expiresAt: daysFromNow(1).toISOString(),
    } : null,
    pricing: {
      ticketsSubtotal,
      serviceFee,
      discount: pixDiscount,
      finalTotal: finalAmount,
    },
    billingAddress,
    createdAt: createdAt.toISOString(),
  };

  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      userId: buyer.id,
      method,
      status: paymentStatus,
      amount: finalAmount,
      transactionId: `SEED-TXN-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      paymentDate: paymentStatus === PaymentStatus.PAID ? createdAt : null,
      metadata: paymentMetadata,
      createdAt,
      updatedAt: createdAt,
    },
  });

  // ── 3. Create Registration ────────────────────────────────────────────────────
  // Status: CONFIRMED if PAID, PENDING if awaiting confirmation, CANCELLED if FAILED
  const regStatus =
    paymentStatus === PaymentStatus.PAID ? RegistrationStatus.CONFIRMED :
    paymentStatus === PaymentStatus.FAILED ? RegistrationStatus.CANCELLED :
    RegistrationStatus.PENDING;

  const registration = await prisma.registration.create({
    data: {
      eventId,
      orderId: order.id,
      userId: buyer.id,
      status: regStatus,
      termsAccepted: true,
      rulesAccepted: true,
      emergencyContactName: null,
      emergencyContactPhone: null,
      createdAt,
      updatedAt: createdAt,
    },
  });

  // Set qrCode — mirrors the JSON payload the service generates
  const qrCodePayload = JSON.stringify({ registrationId: registration.id, eventId, userId: buyer.id });
  await prisma.registration.update({
    where: { id: registration.id },
    data: { qrCode: qrCodePayload, updatedAt: createdAt },
  });

  // ── 4. Create RegistrationTicket with full ticketSnapshot ────────────────────
  // Replicates the exact snapshot shape from checkout.service.ts (lines 1525-1546)
  const ticketSnapshot = {
    id: ticket.id,
    name: ticket.name,
    description: ticket.description ?? null,
    modality: ticket.modality ?? null,
    distance: ticket.distance ?? null,
    distanceUnit: ticket.distanceUnit ?? null,
    gender: ticket.gender ?? null,
    ageLimitMin: ticket.ageLimitMin ?? null,
    ageLimitMax: ticket.ageLimitMax ?? null,
    category: ticket.category ?? null,
    batch: { id: batch.id, price: batch.price },
    products: [],
  };

  await prisma.registrationTicket.create({
    data: {
      registrationId: registration.id,
      ticketId: ticket.id,
      batchId: batch.id,
      ticketSnapshot,
    },
  });

  return { order, payment, registration };
}

// ─── Stage 2: Payment confirmation (webhook) ──────────────────────────────────
// Replicates payments.service.ts handleCieloWebhook / confirmPayment logic

async function confirmPayment(
  payment: any,
  confirmedAt: Date,
  installments = 1,
) {
  const creditCardMeta = (payment.metadata as any)?.creditCard;

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: PaymentStatus.PAID,
      paymentDate: confirmedAt,
      updatedAt: confirmedAt,
      metadata: {
        ...(payment.metadata as any),
        creditCard: creditCardMeta
          ? { ...creditCardMeta, installments }
          : undefined,
        confirmedAt: confirmedAt.toISOString(),
      },
    },
  });

  // Mirrors: prisma.registration.updateMany({ where: { orderId }, data: { status: CONFIRMED } })
  await prisma.registration.updateMany({
    where: { orderId: payment.orderId },
    data: { status: RegistrationStatus.CONFIRMED, updatedAt: confirmedAt },
  });
}

// ─── Stage 2b: Refund (admin marks payment as REFUNDED + cancels registrations)

async function refundPayment(payment: any, refundType: 'REFUND' | 'CHARGEBACK', refundedAt: Date) {
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: PaymentStatus.REFUNDED,
      updatedAt: refundedAt,
      metadata: {
        ...(payment.metadata as any),
        refundType,
        refundedAt: refundedAt.toISOString(),
      },
    },
  });

  await prisma.registration.updateMany({
    where: { orderId: payment.orderId },
    data: { status: RegistrationStatus.CANCELLED, updatedAt: refundedAt },
  });
}

// ─── Stage 3: Withdrawal request ─────────────────────────────────────────────
// Replicates repasse.service.ts requestWithdrawal logic

async function createWithdrawal(
  eventId: string,
  requestedById: string,
  amount: number, // cents
  feeRate: number,
  status: WithdrawalStatus,
  createdAt: Date,
  completedAt?: Date,
  notes?: string,
) {
  const feeAmount = Math.round(amount * feeRate);
  const netAmount = amount - feeAmount;

  return prisma.eventWithdrawal.create({
    data: {
      eventId,
      requestedById,
      amount,
      feeRate,
      feeAmount,
      netAmount,
      status,
      completedAt: completedAt ?? null,
      notes: notes ?? null,
      createdAt,
      updatedAt: createdAt,
    },
  });
}

// ─── Stage 4: Audit ───────────────────────────────────────────────────────────
// Replicates admin approveAudit logic

async function createAudit(eventId: string, auditedById: string, retentionReleased: number) {
  const existing = await prisma.eventAudit.findUnique({ where: { eventId } });
  if (existing) {
    console.log('  EventAudit already exists — skipping. Run with --reset to replace.');
    return null;
  }
  return prisma.eventAudit.create({
    data: {
      eventId,
      auditedById,
      retentionReleased,
      notes: 'Seed: admin audit approval',
      createdAt: new Date(),
    },
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🌱 seed-repasse — full payment-to-repasse flow simulation\n');
  console.log(`Flags: ${FLAG_RESET ? '--reset ' : ''}${FLAG_AUDIT ? '--audit' : FLAG_RESET ? '' : '(none)'}\n`);

  // ── Resolve event ────────────────────────────────────────────────────────────

  const events = await prisma.event.findMany({
    where: { status: 'PUBLISHED' },
    include: {
      tickets: {
        where: { isActive: true },
        include: {
          batches: { orderBy: { sortOrder: 'asc' } },
          category: { select: { id: true, name: true } },
        },
        take: 3,
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (events.length === 0) {
    throw new Error('No published events found. Create and publish an event first.');
  }

  let event: typeof events[0];

  if (eventArg) {
    const found = events.find((e) => e.id === eventArg || e.slug === eventArg);
    if (!found) {
      console.log('Available events:');
      events.forEach((e) => console.log(`  ${e.id}  ${e.slug ?? '-'}  ${e.name}`));
      throw new Error(`Event "${eventArg}" not found.`);
    }
    event = found;
  } else if (events.length === 1) {
    event = events[0];
  } else {
    console.log('Multiple events found. Pass an ID or slug as the first argument:');
    events.forEach((e) => console.log(`  ${e.id}  ${e.slug ?? '-'}  ${e.name}`));
    event = events[0];
    console.log(`\nDefaulting to: ${event.name}\n`);
  }

  const ticket = event.tickets[0];
  if (!ticket) throw new Error(`Event "${event.name}" has no active tickets.`);

  const batch = ticket.batches[0];
  if (!batch) throw new Error(`Ticket "${ticket.name}" has no batches.`);

  console.log(`Event : ${event.name}`);
  console.log(`ID    : ${event.id}`);
  console.log(`Ticket: ${ticket.name}  |  Batch: #${batch.sortOrder + 1}  |  Price: R$ ${(batch.price / 100).toFixed(2)}`);
  console.log(`retentionRate: ${((event.retentionRate ?? 0.1) * 100).toFixed(0)}%  |  organizerFeeRate: ${((event.organizerFeeRate ?? 0.04) * 100).toFixed(0)}%\n`);

  // ── Resolve org owner ────────────────────────────────────────────────────────

  const orgMember = await prisma.organizationMember.findFirst({
    where: {
      organization: { events: { some: { id: event.id } } },
      role: 'OWNER',
    },
    select: { userId: true },
  });

  if (!orgMember) throw new Error('Could not find organization owner for this event.');
  const orgOwnerId = orgMember.userId;

  // ── Reset ────────────────────────────────────────────────────────────────────

  if (FLAG_RESET) await resetEvent(event.id);

  // ── Seed users ───────────────────────────────────────────────────────────────

  const users = await ensureSeedUsers(16);
  let ui = 0;
  const next = () => users[ui++ % users.length];
  const retentionRate = event.retentionRate ?? 0.1;
  const organizerFeeRate = event.organizerFeeRate ?? 0.04;

  console.log('─── Stage 1 + 2: Checkout → Payment confirmation ─────────────────\n');

  // ── Scenario A: PIX recent (< 1 day) → aguardandoLiberacao ──────────────────

  console.log('A. PIX recent (2 orders) → aguardandoLiberacao');
  for (let i = 0; i < 2; i++) {
    const buyer = next();
    const at = daysAgo(0, 2 + i); // 2-3 hours ago
    const { payment } = await runCheckout(event.id, {
      buyer, ticket, batch,
      method: PaymentMethod.PIX,
      paymentStatus: PaymentStatus.PENDING,
      createdAt: at,
      label: `PIX recent #${i + 1}`,
    });
    // Webhook confirms payment ~1 minute later
    await confirmPayment(payment, new Date(at.getTime() + 60_000));
  }

  // ── Scenario B: CC à vista recent (< 31 days) → aguardandoLiberacao ─────────

  console.log('B. CC à vista recent (3 orders) → aguardandoLiberacao');
  for (let i = 0; i < 3; i++) {
    const buyer = next();
    const at = daysAgo(5 + i * 3); // 5, 8, 11 days ago
    // CC approved immediately — payment already PAID at checkout
    await runCheckout(event.id, {
      buyer, ticket, batch,
      method: PaymentMethod.CREDIT_CARD,
      paymentStatus: PaymentStatus.PAID,
      createdAt: at,
      label: `CC recent #${i + 1}`,
    });
  }

  // ── Scenario C: CC à vista old (> 31 days) → valorRetido + saldoDisponivel ──

  console.log('C. CC à vista old (4 orders) → valorRetido + saldoDisponivel');
  for (let i = 0; i < 4; i++) {
    const buyer = next();
    const at = daysAgo(35 + i * 7); // 35, 42, 49, 56 days ago
    await runCheckout(event.id, {
      buyer, ticket, batch,
      method: PaymentMethod.CREDIT_CARD,
      paymentStatus: PaymentStatus.PAID,
      createdAt: at,
      label: `CC old #${i + 1}`,
    });
  }

  // ── Scenario D: PIX old (> 1 day) → saldoDisponivel ─────────────────────────

  console.log('D. PIX old (3 orders) → saldoDisponivel');
  for (let i = 0; i < 3; i++) {
    const buyer = next();
    const at = daysAgo(3 + i * 2); // 3, 5, 7 days ago
    const { payment } = await runCheckout(event.id, {
      buyer, ticket, batch,
      method: PaymentMethod.PIX,
      paymentStatus: PaymentStatus.PENDING,
      createdAt: at,
      label: `PIX old #${i + 1}`,
    });
    // Webhook confirmed minutes after checkout
    await confirmPayment(payment, new Date(at.getTime() + 3 * 60_000));
  }

  // ── Scenario E: CC 3x installments → parceladosAReceber (future installments)

  console.log('E. CC 3x installments (2 orders) → parceladosAReceber');
  for (let i = 0; i < 2; i++) {
    const buyer = next();
    const at = daysAgo(4 + i); // 4-5 days ago; installments due ~27, ~58, ~89 days from payment
    // Installment orders use a larger finalAmount (e.g. batch.price × 3)
    // We simulate by creating the order at 3× price to exercise installment math
    const installBatch = { ...batch, price: batch.price * 3 };
    await runCheckout(event.id, {
      buyer, ticket, batch: installBatch,
      method: PaymentMethod.CREDIT_CARD,
      paymentStatus: PaymentStatus.PAID,
      createdAt: at,
      installments: 3,
      label: `CC 3x #${i + 1}`,
    });
    // Patch metadata to include installments for calcBreakdown to detect
    await prisma.payment.updateMany({
      where: { order: { eventId: event.id }, method: PaymentMethod.CREDIT_CARD },
      data: {}, // Already set in runCheckout via creditCardMeta.installments
    });
  }

  // ── Scenario F: CC à vista REFUND (old) → deducts from saldoDisponivel ──────

  console.log('F. CC à vista refund (1 order) → deducts saldoDisponivel');
  {
    const buyer = next();
    const at = daysAgo(40);
    const { payment } = await runCheckout(event.id, {
      buyer, ticket, batch,
      method: PaymentMethod.CREDIT_CARD,
      paymentStatus: PaymentStatus.PAID,
      createdAt: at,
      label: 'CC refund',
    });
    await refundPayment(payment, 'REFUND', daysAgo(5));
  }

  // ── Scenario G: CC 2x installment REFUND → deducts parceladosAReceber first ─

  console.log('G. CC 2x installment refund (1 order) → deducts parceladosAReceber first');
  {
    const buyer = next();
    const at = daysAgo(3);
    const installBatch2 = { ...batch, price: batch.price * 2 };
    const { payment } = await runCheckout(event.id, {
      buyer, ticket, batch: installBatch2,
      method: PaymentMethod.CREDIT_CARD,
      paymentStatus: PaymentStatus.PAID,
      createdAt: at,
      installments: 2,
      label: 'CC 2x refund',
    });
    await refundPayment(payment, 'REFUND', daysAgo(1));
  }

  // ── Scenario H: CC FAILED → no bucket ────────────────────────────────────────

  console.log('H. CC failed (1 order) → no bucket\n');
  {
    const buyer = next();
    const at = daysAgo(1);
    await runCheckout(event.id, {
      buyer, ticket, batch,
      method: PaymentMethod.CREDIT_CARD,
      paymentStatus: PaymentStatus.FAILED,
      createdAt: at,
      label: 'CC failed',
    });
  }

  // ── Stage 3: Withdrawals ─────────────────────────────────────────────────────

  console.log('─── Stage 3: Withdrawals ────────────────────────────────────────\n');

  const withdrawAmount = Math.round(batch.price * 2); // R$ 2 tickets worth

  const w1 = await createWithdrawal(
    event.id, orgOwnerId, withdrawAmount, organizerFeeRate,
    WithdrawalStatus.COMPLETED, daysAgo(10), daysAgo(8),
    'Seed: first withdrawal — already completed by admin',
  );
  console.log(`  ✓ COMPLETED withdrawal  R$ ${(withdrawAmount / 100).toFixed(2)}  (approved ${daysAgo(8).toLocaleDateString('pt-BR')})`);

  const w2 = await createWithdrawal(
    event.id, orgOwnerId, withdrawAmount, organizerFeeRate,
    WithdrawalStatus.PENDING, daysAgo(1), undefined,
    'Seed: second withdrawal — awaiting admin approval',
  );
  console.log(`  ✓ PENDING withdrawal    R$ ${(withdrawAmount / 100).toFixed(2)}  (requested ${daysAgo(1).toLocaleDateString('pt-BR')})`);
  console.log(`  Both reduce saldoParaSaque: total deducted R$ ${((withdrawAmount * 2) / 100).toFixed(2)}\n`);

  // ── Stage 4: Audit (optional) ─────────────────────────────────────────────────

  if (FLAG_AUDIT) {
    console.log('─── Stage 4: EventAudit ─────────────────────────────────────────\n');
    // retentionReleased = 10% of old CC orders (4 orders × batch.price)
    const retentionReleased = Math.round(4 * batch.price * retentionRate);
    const audit = await createAudit(event.id, orgOwnerId, retentionReleased);
    if (audit) {
      console.log(`  ✓ EventAudit created — released R$ ${(retentionReleased / 100).toFixed(2)}`);
      console.log('  valorRetido is now 0; amount moved to saldoDisponivel\n');
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────────

  const px = batch.price;
  const r = retentionRate;

  // Approximate expected buckets (matches calcBreakdown logic):
  const aguardando = (2 + 3) * px;                                    // A+B
  const oldCC = 4 * px;                                               // C
  const vRetido = FLAG_AUDIT ? 0 : Math.round(oldCC * r);
  const cSaldo = FLAG_AUDIT ? oldCC : oldCC - Math.round(oldCC * r);
  const dSaldo = 3 * px;                                              // D (PIX old, audited by 1-day rule)
  const installTotal = (3 * px * 3) + (3 * px * 2);                  // E: 2 orders × (3x and 2x not right, let's be clear)
  // E: 2 orders of 3x at batch.price*3 each
  const installE = 2 * (batch.price * 3);
  const installRetained = FLAG_AUDIT ? 0 : Math.round(installE * r);
  const installDistrib = installE - Math.round(installE * r);
  const parcelados = installDistrib + installRetained; // all future (paid only 4-5 days ago)
  // G refund on 2x install: orgNet = batch.price*2
  const refundG = batch.price * 2;
  const fromParcelados = Math.min(refundG, parcelados);
  const parceladosNet = parcelados - fromParcelados;
  // F refund on CC old: orgNet = batch.price
  const refundF = px;
  const saldo = cSaldo + dSaldo - refundF - (refundG - fromParcelados);
  const withdrawn = withdrawAmount * 2;
  const saldoParaSaque = saldo - withdrawn;

  console.log('─── Expected repasse/summary values ─────────────────────────────\n');
  console.log(`  aguardandoLiberacao : R$ ${(aguardando / 100).toFixed(2)}`);
  console.log(`    ├─ 10% retained   : R$ ${(Math.round(aguardando * r) / 100).toFixed(2)}`);
  console.log(`    └─ 90% in release : R$ ${((aguardando - Math.round(aguardando * r)) / 100).toFixed(2)}`);
  console.log(`  valorRetido         : R$ ${(vRetido / 100).toFixed(2)}${FLAG_AUDIT ? ' (released by audit)' : ''}`);
  console.log(`  parceladosAReceber  : R$ ${(parceladosNet / 100).toFixed(2)}`);
  console.log(`  saldoDisponivel     : R$ ${(saldo / 100).toFixed(2)}`);
  console.log(`  saldoParaSaque      : R$ ${(saldoParaSaque / 100).toFixed(2)}`);
  console.log(`    (after withdrawals: R$ ${(withdrawn / 100).toFixed(2)})\n`);
  console.log(`Verify: GET /api/v1/organizer/events/${event.id}/repasse/summary\n`);

  // ── Counts ────────────────────────────────────────────────────────────────────

  const [orderCount, paymentCount, regCount, withdrawalCount] = await Promise.all([
    prisma.order.count({ where: { eventId: event.id } }),
    prisma.payment.count({ where: { order: { eventId: event.id } } }),
    prisma.registration.count({ where: { eventId: event.id } }),
    prisma.eventWithdrawal.count({ where: { eventId: event.id } }),
  ]);

  console.log('─── Records created ──────────────────────────────────────────────\n');
  console.log(`  Orders       : ${orderCount}`);
  console.log(`  Payments     : ${paymentCount}`);
  console.log(`  Registrations: ${regCount}`);
  console.log(`  Withdrawals  : ${withdrawalCount}`);
  console.log(`  EventAudit   : ${FLAG_AUDIT ? 1 : 0}\n`);
  console.log('Done ✓\n');
}

main()
  .catch((e) => {
    console.error('\n❌ Error:', e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
