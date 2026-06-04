/**
 * ROTEIRO — formas de pagamento aceitas por evento (tela financeira)
 * ==================================================================
 * `EventsService.updateFinancialSettings` deve gravar `acceptedPaymentMethods`
 * quando enviado e NÃO tocar no campo quando omitido. `getFinancialSettings`
 * devolve o valor persistido, com fallback pra todos os métodos quando o
 * registro ainda não tem o campo (pré-migration). Adversarial: array vazio
 * nunca entra no update (estado inválido — mín. 1 é garantido no DTO).
 *
 * Lock pós-publicação (2026-06-04): protege APENAS a divisão da taxa
 * (organizerFeePercent/participantFeePercent). Formas de pagamento e
 * parcelamento seguem editáveis pelo organizador após a publicação —
 * PATCH sem campos de taxa usa `update` direto (sem guard de lock);
 * PATCH com taxa em evento travado → 409 FINANCIAL_SETTINGS_LOCKED.
 */
import { ConflictException } from '@nestjs/common';
import { EventsService } from '../events.service';

const ALL_METHODS = ['PIX', 'DEBIT_CARD', 'CREDIT_CARD'];

describe('EventsService — acceptedPaymentMethods na configuração financeira', () => {
  const build = (
    opts: { storedMethods?: string[]; lockedAt?: Date | null } = {},
  ) => {
    const { storedMethods = ALL_METHODS, lockedAt = null } = opts;
    const update = jest.fn().mockResolvedValue({ id: 'evt-1' });
    // Espelha o guard atômico: evento travado → 0 linhas afetadas
    const updateMany = jest.fn().mockResolvedValue({ count: lockedAt ? 0 : 1 });
    const findUnique = jest.fn().mockImplementation(({ select }: any) => ({
      id: 'evt-1',
      organizerFeePercent: 4,
      participantFeePercent: 2,
      maxInstallments: 1,
      // select pode ou não pedir o campo; espelha o registro do banco
      ...(select?.acceptedPaymentMethods ? { acceptedPaymentMethods: storedMethods } : {}),
      financialSettingsLockedAt: lockedAt,
    }));
    const client: any = { event: { update, updateMany, findUnique } };
    const prisma: any = {
      getWriteClient: () => client,
      getReadClient: () => client,
    };
    const cache: any = { del: jest.fn().mockResolvedValue(undefined) };
    const service = new EventsService(
      prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, cache,
    );
    // Acesso do organizador fora do escopo deste teste
    jest.spyOn(service as any, 'verifyOrganizerAccess').mockResolvedValue(undefined);
    return { service, update, updateMany, findUnique, cache };
  };

  const baseDto = { organizerFeePercent: 4, participantFeePercent: 2, maxInstallments: 1 };

  it('grava acceptedPaymentMethods quando enviado no PATCH', async () => {
    const { service, updateMany } = build();

    await service.updateFinancialSettings('user-1', 'evt-1', {
      ...baseDto,
      acceptedPaymentMethods: ['PIX', 'CREDIT_CARD'],
    });

    const data = updateMany.mock.calls[0][0].data;
    expect(data.acceptedPaymentMethods).toEqual(['PIX', 'CREDIT_CARD']);
  });

  it('omitir o campo → NÃO entra no update (mantém o valor atual)', async () => {
    const { service, updateMany } = build();

    await service.updateFinancialSettings('user-1', 'evt-1', { ...baseDto });

    const data = updateMany.mock.calls[0][0].data;
    expect('acceptedPaymentMethods' in data).toBe(false);
  });

  it('array vazio → NÃO entra no update (nunca zera a whitelist)', async () => {
    const { service, updateMany } = build();

    await service.updateFinancialSettings('user-1', 'evt-1', {
      ...baseDto,
      acceptedPaymentMethods: [],
    });

    const data = updateMany.mock.calls[0][0].data;
    expect('acceptedPaymentMethods' in data).toBe(false);
  });

  it('GET devolve o valor persistido por evento', async () => {
    const { service } = build({ storedMethods: ['PIX'] });

    const res = await service.getFinancialSettings('user-1', 'evt-1');

    expect(res.data.acceptedPaymentMethods).toEqual(['PIX']);
  });

  it('GET com registro sem o campo (pré-migration) → fallback pra todos os métodos', async () => {
    const { service } = build({ storedMethods: undefined });

    const res = await service.getFinancialSettings('user-1', 'evt-1');

    expect(res.data.acceptedPaymentMethods).toEqual(ALL_METHODS);
  });

  // ─────────── Lock pós-publicação: só a divisão da taxa fica travada ───────────

  it('evento TRAVADO: PATCH só de formas de pagamento + parcelamento passa (update direto, sem guard)', async () => {
    const { service, update, updateMany } = build({ lockedAt: new Date('2026-06-01T00:00:00Z') });

    await service.updateFinancialSettings('user-1', 'evt-1', {
      maxInstallments: 3,
      acceptedPaymentMethods: ['PIX'],
    });

    expect(updateMany).not.toHaveBeenCalled();
    const data = update.mock.calls[0][0].data;
    expect(data).toEqual({ maxInstallments: 3, acceptedPaymentMethods: ['PIX'] });
  });

  it('evento TRAVADO: PATCH com divisão da taxa → 409 FINANCIAL_SETTINGS_LOCKED', async () => {
    const { service } = build({ lockedAt: new Date('2026-06-01T00:00:00Z') });

    await expect(
      service.updateFinancialSettings('user-1', 'evt-1', { ...baseDto }),
    ).rejects.toThrow(ConflictException);
  });

  it('evento TRAVADO + bypassLock (admin): taxa atualiza via update direto', async () => {
    const { service, update, updateMany } = build({ lockedAt: new Date('2026-06-01T00:00:00Z') });

    await service.updateFinancialSettings('user-1', 'evt-1', { ...baseDto }, { bypassLock: true });

    expect(updateMany).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].data.organizerFeePercent).toBe(4);
  });

  it('PATCH vazio → no-op: devolve o estado atual sem tocar o banco', async () => {
    const { service, update, updateMany } = build();

    const res = await service.updateFinancialSettings('user-1', 'evt-1', {});

    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(res.data.acceptedPaymentMethods).toEqual(ALL_METHODS);
  });

  it('update bem-sucedido invalida o cache público do evento (checkout lê a whitelist)', async () => {
    const { service, cache } = build();

    await service.updateFinancialSettings('user-1', 'evt-1', {
      acceptedPaymentMethods: ['PIX'],
    });

    expect(cache.del).toHaveBeenCalledWith('event:byId:evt-1');
  });
});
