/**
 * ROTEIRO — estoque das variações de produto derivado das vagas dos ingressos
 * ===========================================================================
 * Regra: o estoque de cada variação de um produto = soma das vagas (Σ quantity de
 * TODOS os lotes) de TODOS os ingressos ATIVOS aos quais o produto está vinculado.
 * A variação opt-out "Sem interesse" fica de fora (segue ilimitada).
 *
 * O recálculo (`syncProductVariationStock`) deve disparar — na MESMA transação — em:
 *   - create (com produtos)        → produtos novos
 *   - update (vínculos/lotes)       → união dos produtos ANTES ∪ DEPOIS
 *   - duplicate (com produtos)      → produtos da cópia (ativa)
 *   - remove soft delete            → produtos vinculados (ingresso vira inativo)
 *   - remove hard delete            → produtos vinculados (vínculos somem por cascade)
 *
 * Os testes validam (a) o WIRING (quando/com quais produtos o sync é chamado) via spy
 * e (b) o SQL emitido pelo helper (productIds parametrizados + exclusão do opt-out).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { TicketsService } from '../tickets.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrganizationsService } from '../../organizations/organizations.service';
import { CacheRedisService } from '../../../common/services/cache-redis.service';
import { DEFAULT_NO_INTEREST_VARIATION_NAME } from '../../products/product.constants';

describe('TicketsService — sincronização de estoque das variações por vagas', () => {
  let service: TicketsService;
  let client: any;
  let tx: any;

  const mockPrisma = { getReadClient: jest.fn(), getWriteClient: jest.fn() };

  beforeEach(async () => {
    // Cliente de transação: cobre todos os métodos tocados dentro de $transaction.
    tx = {
      ticket: {
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
      },
      event: {
        findUnique: jest.fn().mockResolvedValue({ kitSelectionDisplay: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      ticketProduct: {
        deleteMany: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({}),
      },
      ticketBatch: {
        findMany: jest.fn().mockResolvedValue([]),
        delete: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      registrationTicket: { count: jest.fn().mockResolvedValue(0) },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };

    client = {
      // role ADMIN → verifyOrganizerAccess dá bypass nas checagens de organização
      user: { findUnique: jest.fn().mockResolvedValue({ role: 'ADMIN' }) },
      event: { findUnique: jest.fn().mockResolvedValue({ organizationId: 'org-1', name: 'Evento' }) },
      ticket: { findUnique: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
      product: { findMany: jest.fn() },
      registrationTicket: { groupBy: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };
    mockPrisma.getReadClient.mockReturnValue(client);
    mockPrisma.getWriteClient.mockReturnValue(client);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: OrganizationsService,
          useValue: { recordOrganizationAuditLog: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: CacheRedisService, useValue: {} },
      ],
    }).compile();

    service = module.get<TicketsService>(TicketsService);
  });

  afterEach(() => jest.clearAllMocks());

  const spySync = () =>
    jest.spyOn(service as any, 'syncProductVariationStock').mockResolvedValue(undefined);

  // ──────────────────────────────────────────────────────────── CREATE
  it('CREATE com produtos → sincroniza os produtos vinculados (na tx)', async () => {
    tx.ticket.create.mockResolvedValue({ id: 't1', isActive: true, products: [] });
    const sync = spySync();

    await service.create('admin-1', 'evt-1', {
      name: 'Ingresso',
      batches: [{ quantity: 100, price: 1000 }],
      productIds: ['p1', 'p2'],
    } as any);

    expect(sync).toHaveBeenCalledWith(tx, ['p1', 'p2']);
  });

  it('CREATE sem produtos → NÃO sincroniza', async () => {
    tx.ticket.create.mockResolvedValue({ id: 't1', isActive: true, products: [] });
    const sync = spySync();

    await service.create('admin-1', 'evt-1', {
      name: 'Ingresso',
      batches: [{ quantity: 100, price: 1000 }],
    } as any);

    expect(sync).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────── UPDATE
  it('UPDATE trocando vínculos → sincroniza união (produtos ANTES ∪ DEPOIS)', async () => {
    client.ticket.findUnique.mockResolvedValue({
      id: 't1',
      eventId: 'evt-1',
      name: 'Ingresso',
      isActive: true,
      products: [{ productId: 'old1' }],
      registrations: [],
      batches: [],
    });
    client.product.findMany.mockResolvedValue([{ id: 'new1', eventId: 'evt-1', name: 'X' }]);
    tx.ticket.update.mockResolvedValue({
      id: 't1',
      name: 'Ingresso',
      batches: [],
      products: [{ productId: 'new1' }],
      ageLimitMin: null,
      ageLimitMax: null,
    });
    const sync = spySync();

    await service.update('admin-1', 'evt-1', 't1', { productIds: ['new1'] } as any);

    // old1 some (estoque cai), new1 entra (estoque sobe) → ambos recalculados
    expect(sync).toHaveBeenCalledWith(tx, ['old1', 'new1']);
  });

  it('UPDATE sem mexer em produtos/lotes → NÃO sincroniza', async () => {
    client.ticket.findUnique.mockResolvedValue({
      id: 't1',
      eventId: 'evt-1',
      name: 'Ingresso',
      isActive: true,
      products: [{ productId: 'p1' }],
      registrations: [],
      batches: [],
    });
    tx.ticket.update.mockResolvedValue({
      id: 't1',
      name: 'Novo nome',
      batches: [],
      products: [{ productId: 'p1' }],
      ageLimitMin: null,
      ageLimitMax: null,
    });
    const sync = spySync();

    await service.update('admin-1', 'evt-1', 't1', { name: 'Novo nome' } as any);

    expect(sync).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────── DUPLICATE
  it('DUPLICATE com produtos → sincroniza os produtos da cópia', async () => {
    client.ticket.findUnique.mockResolvedValue({
      id: 't1',
      eventId: 'evt-1',
      categoryId: null,
      isActive: true,
      name: 'Ingresso',
      modality: null,
      distance: null,
      distanceUnit: 'KM',
      gender: 'all',
      ageLimitMin: null,
      ageLimitMax: null,
      hasKit: false,
      kitId: null,
      batches: [{ quantity: 50, price: 1000, startDate: null, endDate: null }],
      products: [
        { productId: 'p1', sortOrder: 0 },
        { productId: 'p2', sortOrder: 1 },
      ],
    });
    tx.ticket.create.mockResolvedValue({
      id: 't2',
      isActive: true,
      products: [],
      ageLimitMin: null,
      ageLimitMax: null,
      categoryId: null,
    });
    const sync = spySync();

    await service.duplicate('admin-1', 'evt-1', 't1');

    expect(sync).toHaveBeenCalledWith(tx, ['p1', 'p2']);
  });

  it('DUPLICATE preserva sortOrder/triggerType dos lotes e description (regressão: 2º lote vinha desconfigurado)', async () => {
    // Bug 2026-06-04: a cópia não levava sortOrder/triggerType dos lotes —
    // todos caíam no default (0 / BY_TIME) e o 2º lote perdia a configuração
    // "ativa quando o anterior esgotar". A description do ingresso também sumia.
    client.ticket.findUnique.mockResolvedValue({
      id: 't1',
      eventId: 'evt-1',
      categoryId: null,
      isActive: true,
      name: 'Ingresso',
      description: 'Descrição original',
      modality: null,
      distance: null,
      distanceUnit: 'KM',
      gender: 'all',
      ageLimitMin: null,
      ageLimitMax: null,
      hasKit: false,
      kitId: null,
      batches: [
        {
          quantity: 50,
          availableQuantity: 10, // cópia deve resetar p/ quantity, não herdar vendas
          price: 1000,
          startDate: new Date('2026-07-01'),
          endDate: new Date('2026-07-31'),
          sortOrder: 0,
          triggerType: 'BY_TIME',
        },
        {
          quantity: 30,
          availableQuantity: 30,
          price: 1500,
          startDate: null,
          endDate: null,
          sortOrder: 1,
          triggerType: 'AFTER_PREVIOUS_SOLD_OUT',
        },
      ],
      products: [],
    });
    tx.ticket.create.mockResolvedValue({
      id: 't2',
      isActive: true,
      products: [],
      batches: [],
      ageLimitMin: null,
      ageLimitMax: null,
      categoryId: null,
    });

    await service.duplicate('admin-1', 'evt-1', 't1');

    expect(tx.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Ingresso (Cópia)',
          description: 'Descrição original',
          batches: {
            create: [
              expect.objectContaining({
                quantity: 50,
                availableQuantity: 50,
                price: 1000,
                sortOrder: 0,
                triggerType: 'BY_TIME',
              }),
              expect.objectContaining({
                quantity: 30,
                availableQuantity: 30,
                price: 1500,
                sortOrder: 1,
                triggerType: 'AFTER_PREVIOUS_SOLD_OUT',
              }),
            ],
          },
        }),
      }),
    );
  });

  // ──────────────────────────────────────────────────────────── REMOVE
  it('REMOVE soft delete (com vendas) → marca inativo e sincroniza vinculados', async () => {
    client.ticket.findUnique.mockResolvedValue({
      id: 't1',
      eventId: 'evt-1',
      isActive: true,
      registrations: [{ id: 'r1' }], // tem venda → soft delete
      reservedTickets: [],
      products: [{ productId: 'p1' }, { productId: 'p2' }],
    });
    const sync = spySync();

    await service.remove('admin-1', 'evt-1', 't1');

    expect(tx.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 't1' }, data: { isActive: false } }),
    );
    expect(tx.ticket.delete).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledWith(tx, ['p1', 'p2']);
  });

  it('REMOVE hard delete (sem vendas) → deleta e sincroniza vinculados', async () => {
    client.ticket.findUnique.mockResolvedValue({
      id: 't1',
      eventId: 'evt-1',
      isActive: true,
      registrations: [],
      reservedTickets: [],
      products: [{ productId: 'p1' }],
    });
    const sync = spySync();

    await service.remove('admin-1', 'evt-1', 't1');

    expect(tx.ticket.delete).toHaveBeenCalledWith({ where: { id: 't1' } });
    expect(sync).toHaveBeenCalledWith(tx, ['p1']);
  });

  // ──────────────────────────────────────────────────────── HELPER (SQL)
  describe('syncProductVariationStock (SQL emitido)', () => {
    it('emite UPDATE com os productIds (dedup) e exclui a variação "Sem interesse"', async () => {
      await (service as any).syncProductVariationStock(tx, ['p1', 'p2', 'p1']);

      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      const sql = tx.$executeRaw.mock.calls[0][0];
      // parâmetros: ids (uuid) + nome da variação opt-out excluída
      expect(sql.values).toEqual(
        expect.arrayContaining(['p1', 'p2', DEFAULT_NO_INTEREST_VARIATION_NAME]),
      );
      // dedup: 'p1' aparece uma única vez nos parâmetros
      expect(sql.values.filter((v: unknown) => v === 'p1').length).toBe(1);
    });

    it('sem productIds → no-op (não executa SQL)', async () => {
      await (service as any).syncProductVariationStock(tx, []);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });
  });
});
