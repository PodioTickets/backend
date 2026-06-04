/**
 * ROTEIRO — formas de pagamento aceitas por evento (tela financeira)
 * ==================================================================
 * `EventsService.updateFinancialSettings` deve gravar `acceptedPaymentMethods`
 * quando enviado e NÃO tocar no campo quando omitido. `getFinancialSettings`
 * devolve o valor persistido, com fallback pra todos os métodos quando o
 * registro ainda não tem o campo (pré-migration). Adversarial: array vazio
 * nunca entra no update (estado inválido — mín. 1 é garantido no DTO).
 */
import { EventsService } from '../events.service';

const ALL_METHODS = ['PIX', 'DEBIT_CARD', 'CREDIT_CARD'];

describe('EventsService — acceptedPaymentMethods na configuração financeira', () => {
  const build = (storedMethods: string[] | undefined = ALL_METHODS) => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findUnique = jest.fn().mockImplementation(({ select }: any) => ({
      id: 'evt-1',
      organizerFeePercent: 4,
      participantFeePercent: 2,
      maxInstallments: 1,
      // select pode ou não pedir o campo; espelha o registro do banco
      ...(select?.acceptedPaymentMethods ? { acceptedPaymentMethods: storedMethods } : {}),
      financialSettingsLockedAt: null,
    }));
    const client: any = { event: { updateMany, findUnique } };
    const prisma: any = {
      getWriteClient: () => client,
      getReadClient: () => client,
    };
    const service = new EventsService(
      prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    // Acesso do organizador fora do escopo deste teste
    jest.spyOn(service as any, 'verifyOrganizerAccess').mockResolvedValue(undefined);
    return { service, updateMany, findUnique };
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
    const { service } = build(['PIX']);

    const res = await service.getFinancialSettings('user-1', 'evt-1');

    expect(res.data.acceptedPaymentMethods).toEqual(['PIX']);
  });

  it('GET com registro sem o campo (pré-migration) → fallback pra todos os métodos', async () => {
    const { service } = build(undefined);

    const res = await service.getFinancialSettings('user-1', 'evt-1');

    expect(res.data.acceptedPaymentMethods).toEqual(ALL_METHODS);
  });
});
