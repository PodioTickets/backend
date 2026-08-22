/**
 * ROTEIRO — teto da taxa TOTAL por organização (taxa de organizador personalizada)
 * =================================================================================
 * `EventsService.updateFinancialSettings` enforça, de forma AUTORITATIVA, o teto da
 * taxa total (organizador + comprador) conforme a ORGANIZAÇÃO dona do evento:
 *   - `customFeeEnabled = false` (ou org ausente) → teto FIXO de 6% (4 + 2).
 *   - `customFeeEnabled = true`  → teto = `maxTotalFeePercent` definido pelo admin.
 * Acima do teto → 400 (BadRequestException); no teto ou abaixo → passa. Só é checado
 * quando o PATCH toca a divisão da taxa (organizer/participant). O front é só UX.
 */
import { BadRequestException } from '@nestjs/common';
import { EventsService } from '../events.service';

describe('EventsService.updateFinancialSettings — teto da taxa total por organização', () => {
  const build = (
    org: { customFeeEnabled?: boolean; maxTotalFeePercent?: number } | null,
    stored: { organizerFeePercent?: number; participantFeePercent?: number } = {},
  ) => {
    const { organizerFeePercent = 4, participantFeePercent = 2 } = stored;
    const update = jest.fn().mockResolvedValue({ id: 'evt-1' });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    // findUnique espelha o evento; quando o select pede a organização, devolve a config.
    const findUnique = jest.fn().mockImplementation(({ select }: any) => ({
      id: 'evt-1',
      organizerFeePercent,
      participantFeePercent,
      maxInstallments: 1,
      financialSettingsLockedAt: null,
      ...(select?.organization ? { organization: org } : {}),
    }));
    const client: any = { event: { update, updateMany, findUnique } };
    const prisma: any = { getWriteClient: () => client, getReadClient: () => client };
    const service = new EventsService(
      prisma, {} as any, { recordOrganizationAuditLog: jest.fn() } as any, {} as any, {} as any, {} as any, {} as any, { del: jest.fn().mockResolvedValue(undefined) } as any,
    );
    jest.spyOn(service as any, 'verifyOrganizerAccess').mockResolvedValue(undefined);
    return { service, update, updateMany };
  };

  it('org SEM taxa personalizada: total ≤ 6 passa', async () => {
    const { service, updateMany } = build({ customFeeEnabled: false });
    await service.updateFinancialSettings('u', 'evt-1', {
      organizerFeePercent: 4,
      participantFeePercent: 2,
      maxInstallments: 1,
    });
    expect(updateMany).toHaveBeenCalled();
  });

  it('org SEM taxa personalizada: total 7 (> 6) → 400', async () => {
    const { service } = build({ customFeeEnabled: false });
    await expect(
      service.updateFinancialSettings('u', 'evt-1', {
        organizerFeePercent: 4,
        participantFeePercent: 3,
        maxInstallments: 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('org ausente na relação → trata como 6% fixo (total 8 → 400)', async () => {
    const { service } = build(null);
    await expect(
      service.updateFinancialSettings('u', 'evt-1', {
        organizerFeePercent: 5,
        participantFeePercent: 3,
        maxInstallments: 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('org COM taxa personalizada (teto 10): total 8 passa', async () => {
    const { service, updateMany } = build({ customFeeEnabled: true, maxTotalFeePercent: 10 });
    await service.updateFinancialSettings('u', 'evt-1', {
      organizerFeePercent: 5,
      participantFeePercent: 3,
      maxInstallments: 1,
    });
    expect(updateMany).toHaveBeenCalled();
  });

  it('org COM taxa personalizada (teto 10): total 12 (> 10) → 400', async () => {
    const { service } = build({ customFeeEnabled: true, maxTotalFeePercent: 10 });
    await expect(
      service.updateFinancialSettings('u', 'evt-1', {
        organizerFeePercent: 6,
        participantFeePercent: 6,
        maxInstallments: 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('teto usa o valor ATUAL do campo omitido (PATCH parcial): só organizer alto → 400', async () => {
    // Evento tem participant 2 gravado; PATCH sobe só o organizer p/ 5 → total 7 > 6.
    const { service } = build({ customFeeEnabled: false }, { participantFeePercent: 2 });
    await expect(
      service.updateFinancialSettings('u', 'evt-1', { organizerFeePercent: 5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('PATCH que NÃO toca a taxa (só formas de pagamento) → não enforça o teto', async () => {
    // Sem tocar a divisão da taxa, usa `update` direto (sem guard de lock nem checagem
    // de teto) — o enforcement só roda quando organizer/participant mudam.
    const { service, update } = build({ customFeeEnabled: false });
    await service.updateFinancialSettings('u', 'evt-1', {
      acceptedPaymentMethods: ['PIX'],
    });
    expect(update).toHaveBeenCalled();
  });
});
