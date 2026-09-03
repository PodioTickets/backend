/**
 * seed-revision-flow.ts
 *
 * Popula o banco LOCAL com o cenário do fluxo de auditoria de eventos:
 * admin, organizador com organização, e três eventos em estados diferentes
 * (REVISION, CHANGES_REQUESTED, DRAFT) para testar a recusa ponta a ponta.
 *
 * Uso (o DATABASE_URL PRECISA ser passado explicitamente — o .env aponta para o
 * Cloud SQL de homologação e rodar isto contra ele criaria lixo em homolog):
 *
 *   cross-env DATABASE_URL=postgresql://user:pass@localhost:5432/db \
 *     ts-node --project tsconfig.node.json prisma/seed-revision-flow.ts
 *
 * Idempotente: reexecutar atualiza os mesmos registros (chaveados por e-mail e
 * por slug do evento) em vez de duplicar.
 */

import {
  PrismaClient,
  AccountType,
  UserRole,
  EventStatus,
  OrganizationMemberRole,
  DocumentType,
  Gender,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const PASSWORD = 'Podio123!';

// CPFs distintos por usuário: `User.documentNumber` é único no schema.
// Ambos são válidos no dígito verificador (os validadores do app checam isso).
const ADMIN = {
  email: 'admin.auditoria@podioticket.com.br',
  firstName: 'Marina',
  lastName: 'Auditora',
  document: '529.982.247-25',
};

const ORGANIZER = {
  email: 'organizador.teste@podioticket.com.br',
  firstName: 'Rafael',
  lastName: 'Mendes',
  document: '111.444.777-35',
};

/** Guarda contra rodar por engano contra o Cloud SQL de homologação. */
function assertLocalDatabase() {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) {
    throw new Error('DATABASE_URL não definida. Passe explicitamente o banco local.');
  }
  const isLocal = /@(localhost|127\.0\.0\.1|postgres):/.test(url);
  if (!isLocal) {
    throw new Error(
      `Recusando rodar: DATABASE_URL não parece ser local (${url.replace(/:\/\/[^@]+@/, '://***@')}).\n` +
        'Este script cria dados de teste — nunca aponte para homologação/produção.',
    );
  }
}

async function upsertUser(data: {
  email: string;
  firstName: string;
  lastName: string;
  document: string;
  role: UserRole;
  accountType: AccountType;
}) {
  const { document, ...user } = data;
  const password = await bcrypt.hash(PASSWORD, 12);
  const existing = await prisma.user.findFirst({
    where: { email: data.email, accountType: data.accountType },
    select: { id: true },
  });

  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { password, role: data.role, isActive: true, deletedAt: null },
    });
    return existing.id;
  }

  const created = await prisma.user.create({
    data: {
      ...user,
      password,
      isActive: true,
      acceptedTerms: true,
      acceptedPrivacyPolicy: true,
      phone: '11987654321',
      documentType: DocumentType.CPF,
      documentNumber: document,
      documentNumberClean: document.replace(/\D/g, ''),
      gender: Gender.MALE,
      dateOfBirth: new Date('1990-04-12T00:00:00Z'),
      country: 'Brasil',
      state: 'SP',
      city: 'São Paulo',
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Cria (ou recria) um evento completo o bastante para passar pelas validações
 * de `EventsService.publish`: local completo, data futura e ≥1 ingresso ativo.
 */
async function upsertEvent(params: {
  organizationId: string;
  slug: string;
  name: string;
  status: EventStatus;
  daysFromNow: number;
  rejection?: { reason: string; at: Date; byId: string };
}) {
  const eventDate = new Date(Date.now() + params.daysFromNow * 24 * 60 * 60 * 1000);
  const registrationStartDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const registrationEndDate = new Date(eventDate.getTime() - 3 * 24 * 60 * 60 * 1000);

  const base = {
    organizationId: params.organizationId,
    name: params.name,
    description:
      'Prova de rua com percursos de 5km, 10km e 21km pelas ruas do centro histórico. ' +
      'Kit com camiseta técnica, número de peito com chip e medalha de participação.',
    // Asset do próprio front (public/images) — caminho relativo não passa pelos
    // remotePatterns do next/image, então não exige mexer no next.config.ts.
    bannerUrl: '/images/corrida-de-rua-1.png',
    location: 'Parque Ibirapuera — Portão 3',
    locationName: 'Parque Ibirapuera',
    city: 'São Paulo',
    state: 'SP',
    country: 'Brasil',
    zipCode: '04094-050',
    neighborhood: 'Vila Mariana',
    latitude: -23.5874,
    longitude: -46.6576,
    contactEmail: 'contato@corridadocentro.com.br',
    instagram: 'corridadocentro',
    eventDate,
    registrationStartDate,
    registrationEndDate,
    maxParticipants: 800,
    status: params.status,
    organizerFeePercent: 4,
    participantFeePercent: 2,
    maxInstallments: 3 as const,
    // REVISION e CHANGES_REQUESTED nascem do `publish`, que trava o financeiro.
    financialSettingsLockedAt:
      params.status === EventStatus.DRAFT ? null : new Date(),
    rejectionReason: params.rejection?.reason ?? null,
    rejectedAt: params.rejection?.at ?? null,
    rejectedById: params.rejection?.byId ?? null,
  };

  const existing = await prisma.event.findUnique({
    where: { slug: params.slug },
    select: { id: true },
  });

  const event = existing
    ? await prisma.event.update({
        where: { id: existing.id },
        data: base,
        select: { id: true, name: true, slug: true, status: true },
      })
    : await prisma.event.create({
        data: { ...base, slug: params.slug },
        select: { id: true, name: true, slug: true, status: true },
      });

  // Ingressos: recria do zero para o script continuar idempotente.
  await prisma.ticket.deleteMany({ where: { eventId: event.id } });
  await prisma.ticketCategory.deleteMany({ where: { eventId: event.id } });

  const category = await prisma.ticketCategory.create({
    data: { eventId: event.id, name: 'Percursos', order: 0 },
    select: { id: true },
  });

  const tickets = [
    { name: '5km — Caminhada', distance: '5', price: 8900, quantity: 300 },
    { name: '10km — Corrida', distance: '10', price: 12900, quantity: 350 },
    { name: '21km — Meia Maratona', distance: '21', price: 18900, quantity: 150 },
  ];

  for (const [i, t] of tickets.entries()) {
    const ticket = await prisma.ticket.create({
      data: {
        eventId: event.id,
        categoryId: category.id,
        sortOrder: i,
        name: t.name,
        description: `Percurso de ${t.distance}km com hidratação a cada 2,5km.`,
        modality: 'Corrida de rua',
        distance: t.distance,
        distanceUnit: 'KM',
        gender: 'all',
        ageLimitMin: 16,
        isActive: true,
      },
      select: { id: true },
    });

    await prisma.ticketBatch.create({
      data: {
        ticketId: ticket.id,
        quantity: t.quantity,
        availableQuantity: t.quantity,
        price: t.price,
        sortOrder: 0,
        triggerType: 'BY_TIME',
        startDate: registrationStartDate,
        endDate: registrationEndDate,
      },
    });
  }

  return event;
}

async function main() {
  assertLocalDatabase();

  console.log('🌱 Semeando o cenário do fluxo de auditoria...\n');

  const adminId = await upsertUser({
    ...ADMIN,
    role: UserRole.ADMIN,
    accountType: AccountType.USER,
  });
  console.log(`👤 Admin        ${ADMIN.email}`);

  const organizerId = await upsertUser({
    ...ORGANIZER,
    role: UserRole.ORGANIZER,
    accountType: AccountType.ORGANIZER,
  });
  console.log(`👤 Organizador  ${ORGANIZER.email}`);

  const orgData = {
    name: 'Corrida do Centro Eventos Esportivos LTDA',
    tradeName: 'Corrida do Centro',
    email: 'contato@corridadocentro.com.br',
    phone: '1133224455',
    whatsapp: '11987654321',
    city: 'São Paulo',
    state: 'SP',
    zipCode: '01310-100',
    street: 'Avenida Paulista',
    number: '1000',
    neighborhood: 'Bela Vista',
    ownerName: `${ORGANIZER.firstName} ${ORGANIZER.lastName}`,
    ownerDocument: ORGANIZER.document.replace(/D/g, ''),
    bankName: 'Banco do Brasil',
    bankCode: '001',
    agency: '1234',
    account: '56789-0',
    accountType: 'CORRENTE',
    accountHolderName: 'Corrida do Centro Eventos Esportivos LTDA',
    accountHolderDocument: '19131243000197',
    isActive: true,
  };

  const existingOrg = await prisma.organization.findUnique({
    where: { document: '19131243000197' },
    select: { id: true },
  });

  const org = existingOrg
    ? await prisma.organization.update({
        where: { id: existingOrg.id },
        data: orgData,
        select: { id: true, tradeName: true },
      })
    : await prisma.organization.create({
        data: { ...orgData, document: '19131243000197' },
        select: { id: true, tradeName: true },
      });

  await prisma.organizationMember.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: organizerId } },
    update: { role: OrganizationMemberRole.OWNER },
    create: {
      organizationId: org.id,
      userId: organizerId,
      role: OrganizationMemberRole.OWNER,
    },
  });
  console.log(`🏢 Organização  ${org.tradeName} (dono: ${ORGANIZER.email})\n`);

  // 1) Em revisão — é este que o admin vai auditar e recusar.
  const inReview = await upsertEvent({
    organizationId: org.id,
    slug: 'corrida-do-centro-2026',
    name: 'Corrida do Centro 2026',
    status: EventStatus.REVISION,
    daysFromNow: 90,
  });
  console.log(`🟡 REVISION           ${inReview.name}`);
  console.log(`   /admin/events/${inReview.id}/review/information`);

  // 2) Já recusado — para conferir a tela do organizador sem precisar recusar antes.
  const rejected = await upsertEvent({
    organizationId: org.id,
    slug: 'travessia-da-serra-2026',
    name: 'Travessia da Serra 2026',
    status: EventStatus.CHANGES_REQUESTED,
    daysFromNow: 120,
    rejection: {
      reason:
        'O regulamento anexado está em branco. Reenvie o PDF com as regras da prova, ' +
        'incluindo as categorias, o limite de idade de cada uma e o horário de largada.\n\n' +
        'O banner também está fora da proporção mínima (1660x930).',
      at: new Date(),
      byId: adminId,
    },
  });
  console.log(`🟠 CHANGES_REQUESTED  ${rejected.name}`);

  // 3) Rascunho — controle, para conferir que o botão continua "Continuar criação".
  const draft = await upsertEvent({
    organizationId: org.id,
    slug: 'night-run-noturna-2026',
    name: 'Night Run Noturna 2026',
    status: EventStatus.DRAFT,
    daysFromNow: 150,
  });
  console.log(`⚪ DRAFT              ${draft.name}\n`);

  console.log(`🔑 Senha (todos):    ${PASSWORD}`);
}

main()
  .catch((e) => {
    console.error('\n❌', e.message ?? e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
