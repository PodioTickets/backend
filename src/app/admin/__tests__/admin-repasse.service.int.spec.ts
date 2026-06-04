/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: painel ADMIN do repasse (transferências para os organizadores).
 *           Reúne duas frentes que o administrador da plataforma usa:
 *
 *    1) SAQUES (EventWithdrawal): o organizador pede para sacar o saldo do evento;
 *       o admin lista esses pedidos (com paginação, busca por nome/e-mail e filtro
 *       por status), abre um saque específico, aprova (marca PAGO), anexa o
 *       comprovante e pode recusar. Há também uma tela de ESTATÍSTICAS que soma
 *       os saques por status (pendente / concluído / cancelado) e a taxa arrecadada.
 *
 *    2) RETENÇÃO (os 10% segurados até a auditoria pós-evento): o admin vê os
 *       eventos com valor retido PENDENTE (calculado ao vivo) ou já LIBERADO
 *       (auditado), e libera a retenção de um evento (cria a auditoria).
 *
 *  EM RESUMO:
 *    O AdminRepasseService faz dois tipos de coisa: consultas diretas no banco
 *    (lista de saques + estatísticas) e DELEGAÇÃO ao RepasseService para a lógica
 *    de retenção (que envolve cálculo financeiro a partir dos pedidos pagos).
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Listar saques pagina corretamente (page/limit/total/totalPages) e ordena do
 *      mais novo para o mais antigo.
 *    • Buscar por nome do evento / nome / e-mail do solicitante filtra os saques.
 *    • Filtrar por status (PENDING / COMPLETED / CANCELLED) e por evento (eventId).
 *    • Sem nenhum saque, a listagem volta vazia e coerente (total 0, totalPages 0).
 *    • Abrir um saque inexistente dá "não encontrado".
 *    • Aprovar um saque PENDING → vira COMPLETED com data; recusar → CANCELLED.
 *    • Não dá para aprovar/recusar um saque que não está PENDING.
 *    • Estatísticas somam corretamente por status e contam eventos distintos.
 *    • Eventos com retenção: lista os PENDENTES (valor retido > 0) e os LIBERADOS;
 *      a busca e o filtro de status funcionam; liberar a retenção cria a auditoria
 *      e não pode ser liberada duas vezes.
 *
 *  COMO CONFERIMOS:
 *    Teste DE VERDADE contra um banco de teste (descartável). Criamos organização,
 *    usuário, evento, chave PIX, pedidos PAGOS (com Payment real) e saques REAIS no
 *    banco; chamamos as ações do serviço e conferimos o resultado lendo o banco de
 *    volta. Nada é "de faz-de-conta" aqui — só o banco é separado, só para teste,
 *    e é limpo antes de cada cenário.
 *
 *  PREMISSAS / NOTAS PARA QUEM FOR RODAR:
 *    • Construtores: AdminRepasseService(prisma, repasseService). O RepasseService
 *      é instanciado REAL (prisma + OrganizerMemberAccessService real); EmailService
 *      e PaymentsRefundService entram como STUBS vazios — os caminhos de retenção e
 *      de leitura de saques exercitados aqui NÃO os tocam.
 *    • Para um evento aparecer como "pending" em getEventsWithRetention, ele precisa
 *      de pelo menos um pedido PAID com `valorRetido > 0`. Isso só acontece quando o
 *      pagamento já SAIU da janela de retenção (à vista). Usamos
 *      `REPASSE_TIME_OFFSET_DAYS` (honrado fora de produção) para "envelhecer" os
 *      pagamentos sem esperar dias reais — o serviço calcula a retenção (10%) na hora.
 *    • PIX/DÉBITO têm janela 0 (liberam na hora) → já caem no branch "10% retido"
 *      mesmo recém-pagos, mas usamos o offset para deixar explícito e robusto.
 * ============================================================================
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WithdrawalStatus, PaymentMethod, PaymentStatus, OrderStatus } from '@prisma/client';
import { AdminRepasseService } from '../admin-repasse.service';
import { RepasseService } from '../../repasse/repasse.service';
import { OrganizerMemberAccessService } from '../../organizations/organizer-member-access.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  createTestPrisma,
  resetDb,
  seedOrganization,
  seedUser,
  seedEvent,
  seedOrgUserEvent,
} from '../../../common/testing/integration-db';

describe('AdminRepasseService (integração, banco real)', () => {
  let prisma: PrismaService;
  let service: AdminRepasseService;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();

    // RepasseService REAL: precisa do prisma e do OrganizerMemberAccessService reais.
    // Os métodos exercitados aqui (adminGetEventsWithRetention / adminReleaseRetention)
    // NÃO chamam EmailService nem PaymentsRefundService → stubs vazios bastam e mantêm
    // o teste focado no comportamento real de banco/cálculo.
    const memberAccess = new OrganizerMemberAccessService(prisma);
    const repasseService = new RepasseService(
      prisma,
      memberAccess,
      {} as any, // EmailService
      {} as any, // PaymentsRefundService
    );
    service = new AdminRepasseService(prisma, repasseService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    // Garante que nenhum offset de tempo vaze para outros specs da suíte.
    delete process.env.REPASSE_TIME_OFFSET_DAYS;
  });

  beforeEach(async () => {
    await resetDb(prisma); // banco limpo antes de cada cenário
    delete process.env.REPASSE_TIME_OFFSET_DAYS;
  });

  // ── helpers de montagem (criam linhas REAIS no banco de teste) ──────────────

  /** Cria uma chave PIX real da organização e devolve seu id. */
  const seedPixKey = async (organizationId: string) => {
    const k = await prisma.getWriteClient().organizationPixKey.create({
      data: {
        organizationId,
        key: 'org@pix.com',
        keyType: 'EMAIL',
        bankName: 'Banco Teste',
        accountHolderName: 'Org Teste',
        accountHolderDocument: '12345678000199',
      },
      select: { id: true },
    });
    return k.id;
  };

  /** Cria um saque (EventWithdrawal) real com os campos mínimos. */
  const seedWithdrawal = (opts: {
    eventId: string;
    requestedById: string;
    pixKeyId?: string;
    amount?: number;
    netAmount?: number;
    feeAmount?: number;
    feeRate?: number;
    status?: WithdrawalStatus;
    createdAt?: Date;
  }) =>
    prisma.getWriteClient().eventWithdrawal.create({
      data: {
        eventId: opts.eventId,
        requestedById: opts.requestedById,
        amount: opts.amount ?? 10000,
        netAmount: opts.netAmount ?? opts.amount ?? 10000,
        feeAmount: opts.feeAmount ?? 0,
        feeRate: opts.feeRate ?? 0.04,
        status: opts.status ?? WithdrawalStatus.PENDING,
        pixKeyId: opts.pixKeyId ?? null,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    });

  /**
   * Cria um pedido PAID com Payment real, gerando valor retido (10%).
   * À vista (PIX por padrão) → fora da janela cai em "10% retido + 90% saldo".
   * finalAmount 10000 + serviceFee 0, organizerFeePercent 0 → orgNet 10000 → retido 1000.
   */
  const seedPaidOrder = async (opts: {
    eventId: string;
    userId: string;
    finalAmount?: number;
    serviceFee?: number;
    method?: PaymentMethod;
    paymentDate?: Date;
  }) => {
    const finalAmount = opts.finalAmount ?? 10000;
    const order = await prisma.getWriteClient().order.create({
      data: {
        eventId: opts.eventId,
        userId: opts.userId,
        totalAmount: finalAmount,
        serviceFee: opts.serviceFee ?? 0,
        finalAmount,
        status: OrderStatus.PAID,
        payment: {
          create: {
            userId: opts.userId,
            method: opts.method ?? PaymentMethod.PIX,
            status: PaymentStatus.PAID,
            amount: finalAmount,
            paymentDate: opts.paymentDate ?? new Date(),
          },
        },
      },
      select: { id: true },
    });
    return order.id;
  };

  // ════════════════════════════════════════════════════════════════════════
  //  getWithdrawals — listagem paginada de saques (consulta direta no banco)
  // ════════════════════════════════════════════════════════════════════════
  describe('getWithdrawals (listagem de saques)', () => {
    it('sem nenhum saque, retorna lista vazia e paginação coerente (total 0)', async () => {
      const res = await service.getWithdrawals({ page: 1, limit: 10 });
      expect(res.data.withdrawals).toEqual([]);
      expect(res.data.pagination).toEqual({ page: 1, limit: 10, total: 0, totalPages: 0 });
    });

    it('pagina corretamente (page/limit/total/totalPages) e ordena do mais novo p/ o mais antigo', async () => {
      const { organizationId, adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const pixKeyId = await seedPixKey(organizationId);

      // 5 saques com createdAt crescente → o mais novo deve vir primeiro.
      const base = Date.now();
      for (let i = 0; i < 5; i++) {
        await seedWithdrawal({
          eventId,
          requestedById: adminUserId,
          pixKeyId,
          amount: 1000 * (i + 1),
          createdAt: new Date(base + i * 1000),
        });
      }

      const page1 = await service.getWithdrawals({ page: 1, limit: 2 });
      expect(page1.data.pagination).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });
      expect(page1.data.withdrawals).toHaveLength(2);
      // mais novo (amount 5000) primeiro
      expect(page1.data.withdrawals[0].amount).toBe(5000);
      expect(page1.data.withdrawals[1].amount).toBe(4000);

      const page3 = await service.getWithdrawals({ page: 3, limit: 2 });
      expect(page3.data.withdrawals).toHaveLength(1); // sobra 1 na última página
      expect(page3.data.withdrawals[0].amount).toBe(1000);

      // o include traz evento + organização + solicitante + chave PIX
      const w = page1.data.withdrawals[0] as any;
      expect(w.event.id).toBe(eventId);
      expect(w.event.organization.id).toBe(organizationId);
      expect(w.requestedBy.id).toBe(adminUserId);
      expect(w.pixKey.id).toBe(pixKeyId);
    });

    it('filtra por status (PENDING / COMPLETED / CANCELLED)', async () => {
      const { organizationId, adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const pixKeyId = await seedPixKey(organizationId);
      await seedWithdrawal({ eventId, requestedById: adminUserId, pixKeyId, status: WithdrawalStatus.PENDING });
      await seedWithdrawal({ eventId, requestedById: adminUserId, pixKeyId, status: WithdrawalStatus.COMPLETED });
      await seedWithdrawal({ eventId, requestedById: adminUserId, pixKeyId, status: WithdrawalStatus.COMPLETED });

      const pending = await service.getWithdrawals({ page: 1, limit: 10, status: WithdrawalStatus.PENDING });
      expect(pending.data.pagination.total).toBe(1);

      const completed = await service.getWithdrawals({ page: 1, limit: 10, status: WithdrawalStatus.COMPLETED });
      expect(completed.data.pagination.total).toBe(2);
      expect(completed.data.withdrawals.every((w) => w.status === WithdrawalStatus.COMPLETED)).toBe(true);
    });

    it('filtra por evento (eventId) — só traz saques daquele evento', async () => {
      const { organizationId, adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const pixKeyId = await seedPixKey(organizationId);
      const otherEventId = await seedEvent(prisma, organizationId);
      await seedWithdrawal({ eventId, requestedById: adminUserId, pixKeyId });
      await seedWithdrawal({ eventId: otherEventId, requestedById: adminUserId, pixKeyId });

      const res = await service.getWithdrawals({ page: 1, limit: 10, eventId });
      expect(res.data.pagination.total).toBe(1);
      expect((res.data.withdrawals[0] as any).event.id).toBe(eventId);
    });

    it('busca por nome do evento (case-insensitive)', async () => {
      const organizationId = await seedOrganization(prisma);
      const adminUserId = await seedUser(prisma, 'ADMIN');
      const pixKeyId = await seedPixKey(organizationId);
      // evento com nome controlado para a busca
      const evt = await prisma.getWriteClient().event.create({
        data: {
          organizationId,
          name: 'Maratona do Litoral',
          location: 'L', city: 'C', state: 'SP', country: 'BR',
          eventDate: new Date('2030-01-10T12:00:00.000Z'),
          registrationStartDate: new Date('2029-12-01T12:00:00.000Z'),
          registrationEndDate: new Date('2030-01-05T12:00:00.000Z'),
        },
        select: { id: true },
      });
      const otherEventId = await seedEvent(prisma, organizationId); // nome "Evento Teste ..."
      await seedWithdrawal({ eventId: evt.id, requestedById: adminUserId, pixKeyId });
      await seedWithdrawal({ eventId: otherEventId, requestedById: adminUserId, pixKeyId });

      const res = await service.getWithdrawals({ page: 1, limit: 10, search: 'litoral' });
      expect(res.data.pagination.total).toBe(1);
      expect((res.data.withdrawals[0] as any).event.id).toBe(evt.id);
    });

    it('busca pelo e-mail / nome do solicitante', async () => {
      const { organizationId, eventId } = await seedOrgUserEvent(prisma);
      const pixKeyId = await seedPixKey(organizationId);
      const requester = await prisma.getWriteClient().user.create({
        data: {
          email: 'joao.especial@busca.com',
          password: 'x',
          firstName: 'Joao',
          lastName: 'Especial',
          role: 'USER' as any,
        },
        select: { id: true },
      });
      const outro = await seedUser(prisma, 'USER');
      await seedWithdrawal({ eventId, requestedById: requester.id, pixKeyId });
      await seedWithdrawal({ eventId, requestedById: outro, pixKeyId });

      const porEmail = await service.getWithdrawals({ page: 1, limit: 10, search: 'joao.especial' });
      expect(porEmail.data.pagination.total).toBe(1);
      expect((porEmail.data.withdrawals[0] as any).requestedBy.id).toBe(requester.id);

      const porNome = await service.getWithdrawals({ page: 1, limit: 10, search: 'Especial' });
      expect(porNome.data.pagination.total).toBe(1);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  getWithdrawal — abrir um saque específico
  // ════════════════════════════════════════════════════════════════════════
  describe('getWithdrawal (detalhe de um saque)', () => {
    it('retorna o saque com evento + organização + solicitante + chave PIX', async () => {
      const { organizationId, adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const pixKeyId = await seedPixKey(organizationId);
      const w = await seedWithdrawal({ eventId, requestedById: adminUserId, pixKeyId });

      const res = await service.getWithdrawal(w.id);
      expect(res.data.withdrawal.id).toBe(w.id);
      expect((res.data.withdrawal as any).event.organization.id).toBe(organizationId);
      expect((res.data.withdrawal as any).pixKey.id).toBe(pixKeyId);
    });

    it('saque inexistente → NotFound', async () => {
      await expect(
        service.getWithdrawal('00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  approveWithdrawal / rejectWithdrawal / attachWithdrawalReceipt
  // ════════════════════════════════════════════════════════════════════════
  describe('aprovar / recusar / anexar comprovante', () => {
    it('aprovar um saque PENDING → COMPLETED com completedAt (confere no banco)', async () => {
      const { organizationId, adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const pixKeyId = await seedPixKey(organizationId);
      const w = await seedWithdrawal({ eventId, requestedById: adminUserId, pixKeyId });

      const res = await service.approveWithdrawal(w.id);
      expect(res.data.withdrawal.status).toBe(WithdrawalStatus.COMPLETED);
      expect(res.data.withdrawal.completedAt).not.toBeNull();

      const noBanco = await prisma.eventWithdrawal.findUnique({ where: { id: w.id } });
      expect(noBanco?.status).toBe(WithdrawalStatus.COMPLETED);
      expect(noBanco?.completedAt).not.toBeNull();
    });

    it('não dá para aprovar um saque que não está PENDING (ex.: já COMPLETED)', async () => {
      const { organizationId, adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const pixKeyId = await seedPixKey(organizationId);
      const w = await seedWithdrawal({
        eventId, requestedById: adminUserId, pixKeyId, status: WithdrawalStatus.COMPLETED,
      });
      await expect(service.approveWithdrawal(w.id)).rejects.toThrow(BadRequestException);
    });

    it('aprovar saque inexistente → NotFound', async () => {
      await expect(
        service.approveWithdrawal('00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(NotFoundException);
    });

    it('recusar um saque PENDING → CANCELLED com as notas (confere no banco)', async () => {
      const { organizationId, adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const pixKeyId = await seedPixKey(organizationId);
      const w = await seedWithdrawal({ eventId, requestedById: adminUserId, pixKeyId });

      const res = await service.rejectWithdrawal(w.id, 'dados bancários divergentes');
      expect(res.data.withdrawal.status).toBe(WithdrawalStatus.CANCELLED);

      const noBanco = await prisma.eventWithdrawal.findUnique({ where: { id: w.id } });
      expect(noBanco?.status).toBe(WithdrawalStatus.CANCELLED);
      expect(noBanco?.notes).toBe('dados bancários divergentes');
    });

    it('não dá para recusar um saque que não está PENDING', async () => {
      const { organizationId, adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const pixKeyId = await seedPixKey(organizationId);
      const w = await seedWithdrawal({
        eventId, requestedById: adminUserId, pixKeyId, status: WithdrawalStatus.CANCELLED,
      });
      await expect(service.rejectWithdrawal(w.id)).rejects.toThrow(BadRequestException);
    });

    it('anexar comprovante grava a receiptUrl (confere no banco)', async () => {
      const { organizationId, adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const pixKeyId = await seedPixKey(organizationId);
      const w = await seedWithdrawal({ eventId, requestedById: adminUserId, pixKeyId });

      await service.attachWithdrawalReceipt(w.id, 'https://cdn/comprovante.pdf');
      const noBanco = await prisma.eventWithdrawal.findUnique({ where: { id: w.id } });
      expect(noBanco?.receiptUrl).toBe('https://cdn/comprovante.pdf');
    });

    it('anexar comprovante em saque inexistente → NotFound', async () => {
      await expect(
        service.attachWithdrawalReceipt('00000000-0000-0000-0000-000000000000', 'x'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  getStats — estatísticas agregadas dos saques
  // ════════════════════════════════════════════════════════════════════════
  describe('getStats (estatísticas de saques)', () => {
    it('sem saques, retorna tudo zerado', async () => {
      const res = await service.getStats();
      expect(res.data.pending.count).toBe(0);
      expect(res.data.completed.count).toBe(0);
      expect(res.data.cancelled.count).toBe(0);
      expect(res.data.overview.totalWithdrawals).toBe(0);
      expect(res.data.overview.totalEventsWithWithdrawals).toBe(0);
    });

    it('soma por status, conta eventos distintos e calcula a taxa efetiva', async () => {
      const { organizationId, adminUserId, eventId } = await seedOrgUserEvent(prisma);
      const pixKeyId = await seedPixKey(organizationId);
      const otherEventId = await seedEvent(prisma, organizationId);

      // 1 PENDING (amount 5000), 2 COMPLETED (10000 c/ fee 400, 20000 c/ fee 800), 1 CANCELLED (3000)
      await seedWithdrawal({ eventId, requestedById: adminUserId, pixKeyId, amount: 5000, netAmount: 5000, status: WithdrawalStatus.PENDING });
      await seedWithdrawal({ eventId, requestedById: adminUserId, pixKeyId, amount: 10000, netAmount: 9600, feeAmount: 400, status: WithdrawalStatus.COMPLETED });
      await seedWithdrawal({ eventId: otherEventId, requestedById: adminUserId, pixKeyId, amount: 20000, netAmount: 19200, feeAmount: 800, status: WithdrawalStatus.COMPLETED });
      await seedWithdrawal({ eventId, requestedById: adminUserId, pixKeyId, amount: 3000, netAmount: 3000, status: WithdrawalStatus.CANCELLED });

      const res = await service.getStats();
      expect(res.data.pending.count).toBe(1);
      expect(res.data.pending.totalAmount).toBe(5000);
      expect(res.data.completed.count).toBe(2);
      expect(res.data.completed.totalAmount).toBe(30000);
      expect(res.data.cancelled.count).toBe(1);

      // taxas: só os COMPLETED → 1200 sobre 30000 = 4% efetivo
      expect(res.data.fees.totalCollected).toBe(1200);
      expect(res.data.fees.effectiveFeePercent).toBe(4);

      // overview
      expect(res.data.overview.totalWithdrawals).toBe(4);
      // 2 eventos distintos com saque
      expect(res.data.overview.totalEventsWithWithdrawals).toBe(2);
      expect(res.data.overview.totalGrossRequested).toBe(5000 + 30000 + 3000);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  getEventsWithRetention — delega ao RepasseService (cálculo ao vivo)
  // ════════════════════════════════════════════════════════════════════════
  describe('getEventsWithRetention (eventos com retenção — delega ao RepasseService)', () => {
    it('sem eventos com pedido pago, retorna lista vazia e stats zeradas', async () => {
      const res = await service.getEventsWithRetention(1, 10);
      expect(res.data.events).toEqual([]);
      expect(res.data.pagination.total).toBe(0);
      expect(res.data.stats.pendingCount).toBe(0);
      expect(res.data.stats.totalPendingVolume).toBe(0);
    });

    it('evento com pedido PAID fora da janela aparece como PENDING com valor retido (10%)', async () => {
      // envelhece os pagamentos p/ saírem da janela de retenção sem esperar dias reais.
      process.env.REPASSE_TIME_OFFSET_DAYS = '60';
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      // finalAmount 10000, fee 0, orgFee 0 → orgNet 10000; retido = 10% = 1000.
      await seedPaidOrder({ eventId, userId: adminUserId, finalAmount: 10000 });

      const res = await service.getEventsWithRetention(1, 10);
      expect(res.data.pagination.total).toBe(1);
      const evt = res.data.events[0];
      expect(evt.id).toBe(eventId);
      expect(evt.status).toBe('pending');
      expect(evt.retainedAmount).toBe(1000);
      expect(res.data.stats.pendingCount).toBe(1);
      expect(res.data.stats.totalPendingVolume).toBe(1000);
    });

    it('evento sem pedido pago NÃO aparece (filtro orders.some payment PAID)', async () => {
      process.env.REPASSE_TIME_OFFSET_DAYS = '60';
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      await seedPaidOrder({ eventId, userId: adminUserId }); // com pedido → aparece
      await seedEvent(prisma, (await prisma.event.findUnique({ where: { id: eventId } }))!.organizationId); // outro sem pedido

      const res = await service.getEventsWithRetention(1, 10);
      expect(res.data.pagination.total).toBe(1);
      expect(res.data.events[0].id).toBe(eventId);
    });

    it('filtra por status=released: só eventos já auditados (liberados)', async () => {
      process.env.REPASSE_TIME_OFFSET_DAYS = '60';
      const { organizationId, adminUserId, eventId } = await seedOrgUserEvent(prisma);
      await seedPaidOrder({ eventId, userId: adminUserId }); // pendente

      // segundo evento, pago + já liberado (auditado)
      const releasedEventId = await seedEvent(prisma, organizationId);
      await seedPaidOrder({ eventId: releasedEventId, userId: adminUserId });
      await service.releaseRetention(adminUserId, releasedEventId, 'liberado no teste');

      const released = await service.getEventsWithRetention(1, 10, undefined, 'released');
      expect(released.data.events).toHaveLength(1);
      expect(released.data.events[0].id).toBe(releasedEventId);
      expect(released.data.events[0].status).toBe('released');

      const pending = await service.getEventsWithRetention(1, 10, undefined, 'pending');
      expect(pending.data.events).toHaveLength(1);
      expect(pending.data.events[0].id).toBe(eventId);
      expect(pending.data.events[0].status).toBe('pending');
    });

    it('busca por nome do evento filtra a listagem', async () => {
      process.env.REPASSE_TIME_OFFSET_DAYS = '60';
      const organizationId = await seedOrganization(prisma);
      const adminUserId = await seedUser(prisma, 'ADMIN');
      const alvo = await prisma.getWriteClient().event.create({
        data: {
          organizationId,
          name: 'Corrida Noturna Especial',
          location: 'L', city: 'C', state: 'SP', country: 'BR',
          eventDate: new Date('2030-01-10T12:00:00.000Z'),
          registrationStartDate: new Date('2029-12-01T12:00:00.000Z'),
          registrationEndDate: new Date('2030-01-05T12:00:00.000Z'),
        },
        select: { id: true },
      });
      const outro = await seedEvent(prisma, organizationId);
      await seedPaidOrder({ eventId: alvo.id, userId: adminUserId });
      await seedPaidOrder({ eventId: outro, userId: adminUserId });

      const res = await service.getEventsWithRetention(1, 10, 'noturna');
      expect(res.data.pagination.total).toBe(1);
      expect(res.data.events[0].id).toBe(alvo.id);
    });

    it('pagina a lista de eventos retidos (page/limit/total/totalPages)', async () => {
      process.env.REPASSE_TIME_OFFSET_DAYS = '60';
      const organizationId = await seedOrganization(prisma);
      const adminUserId = await seedUser(prisma, 'ADMIN');
      for (let i = 0; i < 3; i++) {
        const evId = await seedEvent(prisma, organizationId);
        await seedPaidOrder({ eventId: evId, userId: adminUserId });
      }

      const res = await service.getEventsWithRetention(1, 2);
      expect(res.data.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
      expect(res.data.events).toHaveLength(2);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  //  releaseRetention — delega ao RepasseService (cria a auditoria)
  // ════════════════════════════════════════════════════════════════════════
  describe('releaseRetention (liberar retenção — delega ao RepasseService)', () => {
    it('libera a retenção criando a auditoria com o valor retido (confere no banco)', async () => {
      process.env.REPASSE_TIME_OFFSET_DAYS = '60';
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      await seedPaidOrder({ eventId, userId: adminUserId, finalAmount: 10000 }); // retido 1000

      const res = await service.releaseRetention(adminUserId, eventId, 'auditoria ok');
      expect(res.data.retentionReleased).toBe(1000);

      const audit = await prisma.eventAudit.findUnique({ where: { eventId } });
      expect(audit).not.toBeNull();
      expect(audit?.retentionReleased).toBe(1000);
      expect(audit?.auditedById).toBe(adminUserId);
      expect(audit?.notes).toBe('auditoria ok');
    });

    it('não permite liberar duas vezes o mesmo evento', async () => {
      process.env.REPASSE_TIME_OFFSET_DAYS = '60';
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      await seedPaidOrder({ eventId, userId: adminUserId });

      await service.releaseRetention(adminUserId, eventId);
      await expect(service.releaseRetention(adminUserId, eventId)).rejects.toThrow(BadRequestException);
    });
  });
});
