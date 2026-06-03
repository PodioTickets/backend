/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: vouchers de um evento (cupons de ingresso GRÁTIS gerados em LOTE).
 *           O organizador cria um "lote" com N vouchers — todos com o mesmo
 *           NOME e a mesma CONFIGURAÇÃO (a quem se aplica, validade, restrição
 *           por CPF/documento etc.), mas cada um com um CÓDIGO único.
 *
 *  EM RESUMO:
 *    Um lote = vários vouchers que compartilham a mesma configuração. Quando o
 *    organizador edita a configuração de UM voucher do lote, essa mudança é
 *    PROPAGADA para todos os outros vouchers ATIVOS do mesmo lote (faz sentido:
 *    validade, a quem se aplica e a lista de documentos são atributos do GRUPO,
 *    não de um voucher individual).
 *
 *  A REGRA DELICADA (foco principal deste teste):
 *    Um voucher já USADO (USED) é IMUTÁVEL — ele fica "congelado" para auditoria.
 *    Porém o organizador AINDA PODE editar a configuração do lote MESMO clicando
 *    num voucher já usado: nesse caso o sistema NÃO dá erro 400; ele apenas
 *    deixa o voucher usado intacto e propaga a nova configuração para os
 *    vouchers ATIVOS do mesmo lote. Só dá erro 400 quando TODOS os vouchers do
 *    lote já foram usados (aí não há nada editável).
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Criar um lote gera N vouchers com códigos únicos e a MESMA configuração.
 *    • Editar a config propaga só para os ATIVOS (o USADO fica intacto).
 *    • Editar PELO voucher usado NÃO dá 400 e aplica a config nos ATIVOS.
 *    • Editar quando TODOS já foram usados → dá 400 (não há o que editar).
 *    • Quem não é da organização do evento NÃO consegue mexer (acesso negado).
 *    • Listar os vouchers de um grupo traz as estatísticas certas (stats).
 *
 *  COMO CONFERIMOS:
 *    Teste DE VERDADE contra um banco de dados de teste (descartável). Criamos
 *    organização, evento e vouchers REAIS no banco, chamamos as ações do
 *    serviço e LEMOS O BANCO DE VOLTA para conferir o resultado — nada é
 *    "faz-de-conta". O banco é separado, só para teste, e é limpo antes de
 *    cada cenário.
 * ============================================================================
 */
import { BadRequestException } from '@nestjs/common';
import { VouchersService } from '../vouchers.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { CpfListStatus, VoucherStatus } from '../dto/create-voucher.dto';
import {
  createTestPrisma,
  resetDb,
  seedOrganization,
  seedUser,
  seedEvent,
  seedOrgUserEvent,
} from '../../../common/testing/integration-db';

describe('VouchersService (integração, banco real)', () => {
  let prisma: PrismaService;
  let service: VouchersService;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    service = new VouchersService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma); // banco limpo antes de cada cenário
  });

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /** Lê do banco TODOS os vouchers de um lote (por nome), ordenados pela criação. */
  const lerLote = (eventId: string, name: string) =>
    prisma.getReadClient().voucher.findMany({
      where: { eventId, name, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });

  /** Marca um voucher específico como USADO direto no banco (simula uma venda). */
  const marcarComoUsado = (id: string) =>
    prisma.getWriteClient().voucher.update({
      where: { id },
      data: { status: VoucherStatus.USED, usedAt: new Date() },
    });

  // =========================================================================
  // CREATE
  // =========================================================================
  describe('create', () => {
    it('gera N vouchers do lote com códigos únicos e configuração compartilhada', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);

      const res = await service.create(adminUserId, eventId, {
        name: 'Lote Convidados',
        quantity: 5,
        appliesTo: ['11111111-1111-1111-1111-111111111111'],
        cpfListStatus: CpfListStatus.ENABLED,
        cpfList: ['123.456.789-00'],
        applyToProducts: true,
      } as any);

      expect(res.data.vouchers).toHaveLength(5);

      // confere no banco de verdade
      const noBanco = await lerLote(eventId, 'Lote Convidados');
      expect(noBanco).toHaveLength(5);

      // todos compartilham o nome e a configuração do lote
      expect(noBanco.every((v) => v.name === 'Lote Convidados')).toBe(true);
      expect(noBanco.every((v) => v.cpfListStatus === 'ENABLED')).toBe(true);
      expect(noBanco.every((v) => v.applyToProducts === true)).toBe(true);
      expect(noBanco.every((v) => v.status === 'ACTIVE')).toBe(true);
      // appliesTo é gravado como JSON string (array de 1 ticket)
      expect(noBanco.every((v) => v.appliesTo === JSON.stringify(['11111111-1111-1111-1111-111111111111']))).toBe(true);
      // cpfList legado preservado + documentList canônico derivado dele
      expect(noBanco.every((v) => Array.isArray(v.documentList) && (v.documentList as any[]).length === 1)).toBe(true);
      expect((noBanco[0].documentList as any[])[0]).toMatchObject({ type: 'CPF', numberClean: '12345678900' });

      // códigos são únicos e têm 8 caracteres
      const codigos = noBanco.map((v) => v.code);
      expect(new Set(codigos).size).toBe(5);
      expect(codigos.every((c) => /^[A-Z0-9]{8}$/.test(c))).toBe(true);
    });
  });

  // =========================================================================
  // UPDATE — propagação de configuração de grupo
  // =========================================================================
  describe('update (propagação de config de lote)', () => {
    it('propaga a config de grupo apenas para os vouchers ATIVOS (deixa o USADO intacto)', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      await service.create(adminUserId, eventId, { name: 'Lote A', quantity: 3 } as any);

      const lote = await lerLote(eventId, 'Lote A');
      const [usado, ativoAlvo, ativoOutro] = lote;

      // congela o primeiro como USADO
      await marcarComoUsado(usado.id);
      const usadoAntes = await prisma.getReadClient().voucher.findUnique({ where: { id: usado.id } });

      // edita a config de grupo PELO voucher ativo (alvo editável)
      await service.update(adminUserId, eventId, ativoAlvo.id, {
        expiryDate: '2027-01-01',
        appliesTo: ['22222222-2222-2222-2222-222222222222'],
        cpfListStatus: CpfListStatus.ENABLED,
        cpfList: ['98765432100'],
        applyToProducts: true,
      } as any);

      // lê o banco de volta
      const depois = await prisma.getReadClient().voucher.findMany({
        where: { eventId, name: 'Lote A', deletedAt: null },
      });
      const mapa = new Map(depois.map((v) => [v.id, v]));

      // o USADO ficou 100% congelado (nada mudou)
      const usadoDepois = mapa.get(usado.id)!;
      expect(usadoDepois.status).toBe('USED');
      expect(usadoDepois.appliesTo).toBe(usadoAntes!.appliesTo); // ainda null
      expect(usadoDepois.cpfListStatus).toBe(usadoAntes!.cpfListStatus); // ainda DISABLED
      expect(usadoDepois.expiryDate).toEqual(usadoAntes!.expiryDate); // ainda null
      expect(usadoDepois.applyToProducts).toBe(usadoAntes!.applyToProducts);

      // os DOIS ATIVOS receberam a nova config
      for (const id of [ativoAlvo.id, ativoOutro.id]) {
        const v = mapa.get(id)!;
        expect(v.status).toBe('ACTIVE');
        expect(v.cpfListStatus).toBe('ENABLED');
        expect(v.applyToProducts).toBe(true);
        expect(v.appliesTo).toBe(JSON.stringify(['22222222-2222-2222-2222-222222222222']));
        expect(v.expiryDate).not.toBeNull();
        expect(Array.isArray(v.documentList)).toBe(true);
        expect((v.documentList as any[])[0]).toMatchObject({ type: 'CPF', numberClean: '98765432100' });
      }
    });

    it('editar PELO voucher USADO NÃO dá 400 e aplica a config nos ATIVOS (alvo fica congelado)', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      await service.create(adminUserId, eventId, { name: 'Lote B', quantity: 3 } as any);

      const lote = await lerLote(eventId, 'Lote B');
      const [usado, ativo1, ativo2] = lote;
      await marcarComoUsado(usado.id);
      const usadoAntes = await prisma.getReadClient().voucher.findUnique({ where: { id: usado.id } });

      // edita o lote PASSANDO O ID DO VOUCHER JÁ USADO → não pode estourar 400
      const res = await service.update(adminUserId, eventId, usado.id, {
        expiryDate: '2028-06-30',
        applyToProducts: true,
      } as any);

      // a resposta representa um voucher ATIVO do lote (não o usado congelado)
      expect(res.data.voucher.status).toBe('ACTIVE');
      expect(res.data.voucher.id).not.toBe(usado.id);

      const depois = await prisma.getReadClient().voucher.findMany({
        where: { eventId, name: 'Lote B', deletedAt: null },
      });
      const mapa = new Map(depois.map((v) => [v.id, v]));

      // o USADO continua intacto
      const usadoDepois = mapa.get(usado.id)!;
      expect(usadoDepois.status).toBe('USED');
      expect(usadoDepois.expiryDate).toEqual(usadoAntes!.expiryDate); // ainda null
      expect(usadoDepois.applyToProducts).toBe(usadoAntes!.applyToProducts); // ainda false

      // os ATIVOS receberam a nova config
      for (const id of [ativo1.id, ativo2.id]) {
        const v = mapa.get(id)!;
        expect(v.status).toBe('ACTIVE');
        expect(v.applyToProducts).toBe(true);
        expect(v.expiryDate).not.toBeNull();
      }
    });

    it('quando TODOS os vouchers do lote já foram usados → dá 400 (não há o que editar)', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      await service.create(adminUserId, eventId, { name: 'Lote C', quantity: 2 } as any);

      const lote = await lerLote(eventId, 'Lote C');
      await Promise.all(lote.map((v) => marcarComoUsado(v.id)));

      await expect(
        service.update(adminUserId, eventId, lote[0].id, { applyToProducts: true } as any),
      ).rejects.toThrow(BadRequestException);

      // garante que nada foi alterado: ambos seguem USED, applyToProducts intacto
      const depois = await lerLote(eventId, 'Lote C');
      expect(depois.every((v) => v.status === 'USED')).toBe(true);
      expect(depois.every((v) => v.applyToProducts === false)).toBe(true);
    });
  });

  // =========================================================================
  // findGroupVouchers — listagem + estatísticas
  // =========================================================================
  describe('findGroupVouchers (stats do grupo)', () => {
    it('retorna a lista paginada e as estatísticas corretas do lote inteiro', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      await service.create(adminUserId, eventId, { name: 'Lote D', quantity: 4 } as any);

      const lote = await lerLote(eventId, 'Lote D');
      // 4 vouchers: 1 USADO, 1 INATIVO, 2 ATIVOS
      await marcarComoUsado(lote[0].id);
      await prisma.getWriteClient().voucher.update({
        where: { id: lote[1].id },
        data: { status: VoucherStatus.INACTIVE },
      });

      const res = await service.findGroupVouchers(eventId, 'Lote D');

      // stats do grupo COMPLETO (independem do filtro)
      expect(res.data.group.totalCount).toBe(4);
      expect(res.data.group.availableCount).toBe(2); // os 2 ATIVOS não expirados
      expect(res.data.group.usedCount).toBe(1);
      expect(res.data.group.inactiveCount).toBe(1);
      expect(res.data.group.expiredCount).toBe(0);
      expect(res.data.group.status).toBe('ACTIVE'); // há disponíveis → ACTIVE
      expect(res.data.group.name).toBe('Lote D');

      // a lista (sem filtro) traz todos os 4
      expect(res.data.vouchers).toHaveLength(4);
      expect(res.data.pagination.total).toBe(4);
    });

    it('respeita o filtro de status na lista, mas mantém as stats do grupo completo', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      await service.create(adminUserId, eventId, { name: 'Lote E', quantity: 3 } as any);

      const lote = await lerLote(eventId, 'Lote E');
      await marcarComoUsado(lote[0].id);

      const res = await service.findGroupVouchers(eventId, 'Lote E', { status: VoucherStatus.USED } as any);

      // a lista filtrada traz só o USADO...
      expect(res.data.vouchers).toHaveLength(1);
      expect(res.data.vouchers[0].status).toBe('USED');
      expect(res.data.pagination.total).toBe(1);
      // ...mas as stats continuam contando o grupo inteiro
      expect(res.data.group.totalCount).toBe(3);
      expect(res.data.group.usedCount).toBe(1);
      expect(res.data.group.availableCount).toBe(2);
    });
  });

  // =========================================================================
  // findAll — agrupamento por lote
  // =========================================================================
  describe('findAll (agrupamento por lote)', () => {
    it('agrupa por nome de lote e conta os status corretamente', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      await service.create(adminUserId, eventId, { name: 'Lote F', quantity: 3 } as any);
      await service.create(adminUserId, eventId, { name: 'Lote G', quantity: 2 } as any);

      const loteF = await lerLote(eventId, 'Lote F');
      await marcarComoUsado(loteF[0].id);

      const res = await service.findAll(eventId);

      expect(res.data.pagination.total).toBe(2); // 2 lotes distintos
      const grupoF = res.data.groups.find((g) => g.name === 'Lote F')!;
      const grupoG = res.data.groups.find((g) => g.name === 'Lote G')!;

      expect(grupoF.totalCount).toBe(3);
      expect(grupoF.usedCount).toBe(1);
      expect(grupoF.activeCount).toBe(2);
      expect(grupoG.totalCount).toBe(2);
      expect(grupoG.activeCount).toBe(2);
    });
  });

  // =========================================================================
  // controle de acesso
  // =========================================================================
  describe('controle de acesso', () => {
    it('nega acesso a quem não faz parte da organização do evento (create)', async () => {
      const orgId = await seedOrganization(prisma);
      const eventId = await seedEvent(prisma, orgId);
      const estranhoId = await seedUser(prisma, 'USER'); // sem vínculo com a org

      await expect(
        service.create(estranhoId, eventId, { name: 'X', quantity: 1 } as any),
      ).rejects.toThrow(BadRequestException);

      // nada foi criado
      const total = await prisma.getReadClient().voucher.count({ where: { eventId } });
      expect(total).toBe(0);
    });

    it('nega acesso a quem não faz parte da organização do evento (update)', async () => {
      const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
      await service.create(adminUserId, eventId, { name: 'Lote H', quantity: 1 } as any);
      const [v] = await lerLote(eventId, 'Lote H');

      const estranhoId = await seedUser(prisma, 'USER'); // sem vínculo
      await expect(
        service.update(estranhoId, eventId, v.id, { applyToProducts: true } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('libera acesso para membro da organização do evento', async () => {
      const orgId = await seedOrganization(prisma);
      const eventId = await seedEvent(prisma, orgId);
      const membroId = await seedUser(prisma, 'USER');
      await prisma.getWriteClient().organizationMember.create({
        data: { organizationId: orgId, userId: membroId, role: 'OWNER' as any },
      });

      await expect(
        service.create(membroId, eventId, { name: 'Lote Membro', quantity: 1 } as any),
      ).resolves.toBeDefined();
    });
  });
});
