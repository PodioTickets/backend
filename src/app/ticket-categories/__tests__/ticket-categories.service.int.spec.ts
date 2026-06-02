/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: categorias de ingresso de um evento (ex.: "Lote 1", "VIP", "Meia").
 *           O organizador pode criar, listar, editar, reordenar e excluir categorias.
 *
 *  EM RESUMO:
 *    Categorias organizam os ingressos do evento em grupos e definem a ORDEM em que
 *    aparecem para o comprador. Só quem é da organização do evento (ou um administrador)
 *    pode mexer nelas.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Ao criar sem escolher a posição, a categoria entra automaticamente no FINAL da lista.
 *    • Ao criar escolhendo a posição, o sistema respeita a posição escolhida.
 *    • Ao listar, as categorias vêm na ordem certa e só mostram os ingressos ATIVOS.
 *    • Ao editar, muda só o que foi enviado (o resto fica como estava).
 *    • Não dá para editar/excluir uma categoria que não é daquele evento.
 *    • Reordenar deixa as categorias exatamente na ordem enviada.
 *    • Não dá para excluir uma categoria que ainda tem ingressos dentro.
 *    • Quem não faz parte da organização do evento não consegue mexer (acesso negado).
 *
 *  COMO CONFERIMOS:
 *    Este é um teste DE VERDADE contra um banco de dados de teste (descartável). Criamos
 *    organização, evento e categorias REAIS no banco, chamamos as ações do sistema e
 *    conferimos o resultado lendo o banco de volta. Nada é "de faz-de-conta" aqui — só o
 *    banco é um banco separado, só para teste, que é limpo antes de cada cenário.
 * ============================================================================
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TicketCategoriesService } from '../ticket-categories.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  createTestPrisma,
  resetDb,
  seedOrganization,
  seedUser,
  seedEvent,
  seedOrgUserEvent,
} from '../../../common/testing/integration-db';

describe('TicketCategoriesService (integração, banco real)', () => {
  let prisma: PrismaService;
  let service: TicketCategoriesService;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    service = new TicketCategoriesService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma); // banco limpo antes de cada cenário
  });

  // helper: cria um ingresso real sob uma categoria
  const createTicket = (eventId: string, categoryId: string, isActive = true) =>
    prisma.getWriteClient().ticket.create({
      data: { eventId, categoryId, name: 'Ingresso', modality: 'Corrida', isActive },
    });

  it('coloca a categoria no final da lista quando o organizador não escolhe a posição', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);

    const r1 = await service.create(adminUserId, eventId, { name: 'Lote 1' } as any);
    const r2 = await service.create(adminUserId, eventId, { name: 'Lote 2' } as any);

    expect(r1.data.category.sortOrder).toBe(0);
    expect(r2.data.category.sortOrder).toBe(1); // entrou depois → final da lista

    // confere no banco de verdade
    const noBanco = await prisma.ticketCategory.findMany({ where: { eventId }, orderBy: { order: 'asc' } });
    expect(noBanco.map((c) => c.name)).toEqual(['Lote 1', 'Lote 2']);
    expect(noBanco.map((c) => c.order)).toEqual([0, 1]);
  });

  it('respeita a posição escolhida ao criar', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);

    const res = await service.create(adminUserId, eventId, { name: 'VIP', sortOrder: 7 } as any);

    expect(res.data.category.sortOrder).toBe(7);
    const c = await prisma.ticketCategory.findFirst({ where: { eventId } });
    expect(c?.order).toBe(7);
  });

  it('lista as categorias na ordem certa e só com ingressos ativos', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    await service.create(adminUserId, eventId, { name: 'B', sortOrder: 1 } as any);
    const a = await service.create(adminUserId, eventId, { name: 'A', sortOrder: 0 } as any);
    await createTicket(eventId, a.data.category.id, true); // ativo → aparece
    await createTicket(eventId, a.data.category.id, false); // inativo → não aparece

    const res = await service.findAll(eventId);

    expect(res.data.categories.map((c) => c.name)).toEqual(['A', 'B']); // ordenado por sortOrder
    const categoriaA = res.data.categories.find((c) => c.name === 'A') as any;
    expect(categoriaA.tickets).toHaveLength(1); // só o ativo
  });

  it('ao editar, muda só o que foi enviado (o resto fica como estava)', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const c = await service.create(adminUserId, eventId, { name: 'Antigo', description: 'desc', sortOrder: 3 } as any);

    await service.update(adminUserId, eventId, c.data.category.id, { name: 'Novo' } as any);

    const noBanco = await prisma.ticketCategory.findUnique({ where: { id: c.data.category.id } });
    expect(noBanco?.name).toBe('Novo');
    expect(noBanco?.description).toBe('desc'); // preservado
    expect(noBanco?.order).toBe(3); // preservado
  });

  it('não deixa editar uma categoria que não é daquele evento', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    // categoria de OUTRO evento
    const orgId2 = await seedOrganization(prisma);
    const eventId2 = await seedEvent(prisma, orgId2);
    const outra = await prisma.ticketCategory.create({ data: { eventId: eventId2, name: 'Outra' } });

    await expect(
      service.update(adminUserId, eventId, outra.id, { name: 'X' } as any),
    ).rejects.toThrow(NotFoundException);
  });

  it('reordena as categorias exatamente na ordem enviada', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const a = await service.create(adminUserId, eventId, { name: 'A' } as any);
    const b = await service.create(adminUserId, eventId, { name: 'B' } as any);
    const c = await service.create(adminUserId, eventId, { name: 'C' } as any);

    await service.reorder(adminUserId, eventId, {
      categoryIds: [c.data.category.id, a.data.category.id, b.data.category.id],
    } as any);

    const noBanco = await prisma.ticketCategory.findMany({ where: { eventId }, orderBy: { order: 'asc' } });
    expect(noBanco.map((x) => x.name)).toEqual(['C', 'A', 'B']);
  });

  it('não deixa excluir categoria que ainda tem ingressos dentro', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const c = await service.create(adminUserId, eventId, { name: 'Com ingresso' } as any);
    await createTicket(eventId, c.data.category.id);

    await expect(service.remove(adminUserId, eventId, c.data.category.id)).rejects.toThrow(
      BadRequestException,
    );
    // continua no banco
    expect(await prisma.ticketCategory.findUnique({ where: { id: c.data.category.id } })).not.toBeNull();
  });

  it('exclui de verdade a categoria quando não há ingressos', async () => {
    const { adminUserId, eventId } = await seedOrgUserEvent(prisma);
    const c = await service.create(adminUserId, eventId, { name: 'Vazia' } as any);

    await service.remove(adminUserId, eventId, c.data.category.id);

    expect(await prisma.ticketCategory.findUnique({ where: { id: c.data.category.id } })).toBeNull();
  });

  it('nega acesso a quem não faz parte da organização do evento', async () => {
    const orgId = await seedOrganization(prisma);
    const eventId = await seedEvent(prisma, orgId);
    const estranhoId = await seedUser(prisma, 'USER'); // não-admin, sem vínculo

    await expect(
      service.create(estranhoId, eventId, { name: 'X' } as any),
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
      service.create(membroId, eventId, { name: 'X' } as any),
    ).resolves.toBeDefined();
  });
});
