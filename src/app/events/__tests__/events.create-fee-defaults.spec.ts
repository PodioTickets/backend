/**
 * ROTEIRO — defaults financeiros snapshotados na CRIAÇÃO do evento
 * ================================================================
 * EventsService.create deve gravar, por evento, as taxas padrão (snapshot):
 *   organizerFeePercent=4 (sobrescrevível), participantFeePercent=2,
 *   retentionRate=0.10, refundFeeRate=0.02.
 * Assim, alterar os defaults vale só pra eventos FUTUROS (existentes mantêm o gravado).
 */
import {
  EventsService,
  DEFAULT_ORGANIZER_FEE_PERCENT,
  DEFAULT_PARTICIPANT_FEE_PERCENT,
  DEFAULT_RETENTION_RATE,
  DEFAULT_REFUND_FEE_RATE,
} from '../events.service';

describe('EventsService.create — defaults financeiros por evento', () => {
  const build = () => {
    const create = jest.fn().mockResolvedValue({ id: 'evt-1', name: 'E', organization: { members: [] } });
    const update = jest.fn().mockResolvedValue({
      id: 'evt-1', name: 'E', slug: 'e-evt1', status: 'DRAFT',
      location: null, city: null, state: null, country: null,
      eventDate: new Date(), registrationStartDate: new Date(), registrationEndDate: new Date(),
      bannerUrl: null, logoUrl: null, organization: { members: [] },
    });
    const writeClient: any = {
      organizationMember: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'm1', role: 'OWNER', organizationId: 'org-1', organization: { id: 'org-1' } },
        ]),
      },
      event: { findFirst: jest.fn().mockResolvedValue(null), create, update },
      eventTopic: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const prisma: any = {
      getWriteClient: () => writeClient,
      getReadClient: () => ({}),
    };
    const organizationsService: any = { recordOrganizationAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new EventsService(
      prisma, {} as any, organizationsService, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    // Evita I/O dos helpers internos (slug e tópico padrão) — fora do escopo deste teste.
    jest.spyOn(service as any, 'generateEventSlug').mockResolvedValue('e-evt1');
    jest.spyOn(service as any, 'ensureDefaultDescriptionTopic').mockResolvedValue(undefined);
    return { service, create };
  };

  const baseDto = () => ({
    name: 'Minha Corrida',
    eventDate: '2026-09-01T00:00:00.000Z',
    registrationStartDate: '2026-07-01T00:00:00.000Z',
    registrationEndDate: '2026-08-30T00:00:00.000Z',
  });

  it('as constantes default têm os valores combinados', () => {
    expect(DEFAULT_ORGANIZER_FEE_PERCENT).toBe(4);
    expect(DEFAULT_PARTICIPANT_FEE_PERCENT).toBe(2);
    expect(DEFAULT_RETENTION_RATE).toBe(0.1);
    expect(DEFAULT_REFUND_FEE_RATE).toBe(0.02);
  });

  it('grava os 4 defaults no event.create', async () => {
    const { service, create } = build();

    await service.create('user-1', baseDto() as any);

    const data = create.mock.calls[0][0].data;
    expect(data.organizerFeePercent).toBe(4);
    expect(data.participantFeePercent).toBe(2);
    expect(data.retentionRate).toBe(0.1);
    expect(data.refundFeeRate).toBe(0.02);
  });

  it('organizerFeePercent do payload é respeitado; retenção/estorno seguem o default', async () => {
    const { service, create } = build();

    await service.create('user-1', { ...baseDto(), organizerFeePercent: 3 } as any);

    const data = create.mock.calls[0][0].data;
    expect(data.organizerFeePercent).toBe(3); // veio do DTO
    expect(data.participantFeePercent).toBe(2); // interno
    expect(data.retentionRate).toBe(0.1); // default
    expect(data.refundFeeRate).toBe(0.02); // default
  });
});
