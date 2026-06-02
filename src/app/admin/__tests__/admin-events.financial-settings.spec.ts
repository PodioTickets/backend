/**
 * ROTEIRO — admin edita retentionRate/refundFeeRate por evento
 * ============================================================
 * `AdminEventsService.updateFinancialSettings` deve gravar e retornar as taxas por
 * evento. Adversarial: confirma que 0 (falsy) é gravado, que campos omitidos NÃO
 * entram no update, e que os valores voltam na resposta.
 */
import { AdminEventsService } from '../admin-events.service';

describe('AdminEventsService.updateFinancialSettings — taxas por evento', () => {
  const build = () => {
    const update = jest.fn();
    const findUnique = jest.fn().mockResolvedValue({ id: 'evt-1' });
    const prisma: any = {
      getWriteClient: () => ({ event: { findUnique, update } }),
    };
    const service = new AdminEventsService(prisma, {} as any);
    // update devolve os campos selecionados (espelha o que o service mapeia na resposta)
    update.mockImplementation(({ data }: any) => ({
      id: 'evt-1',
      organizerFeePercent: data.organizerFeePercent ?? 4,
      participantFeePercent: data.participantFeePercent ?? 2,
      maxInstallments: data.maxInstallments ?? 1,
      retentionRate: data.retentionRate ?? 0.1,
      refundFeeRate: data.refundFeeRate ?? 0.02,
      financialSettingsLockedAt: null,
    }));
    return { service, update };
  };

  it('grava retentionRate e refundFeeRate no update e retorna na resposta', async () => {
    const { service, update } = build();

    const res = await service.updateFinancialSettings('evt-1', {
      retentionRate: 0.15,
      refundFeeRate: 0.03,
    });

    const data = update.mock.calls[0][0].data;
    expect(data.retentionRate).toBe(0.15);
    expect(data.refundFeeRate).toBe(0.03);
    expect(res.data.retentionRate).toBe(0.15);
    expect(res.data.refundFeeRate).toBe(0.03);
  });

  it('aceita taxa 0 (falsy) — escreve 0, não ignora', async () => {
    const { service, update } = build();

    await service.updateFinancialSettings('evt-1', { refundFeeRate: 0, retentionRate: 0 });

    const data = update.mock.calls[0][0].data;
    expect(data.refundFeeRate).toBe(0);
    expect(data.retentionRate).toBe(0);
  });

  it('omitir as taxas → NÃO entram no update (não sobrescreve com undefined)', async () => {
    const { service, update } = build();

    await service.updateFinancialSettings('evt-1', { organizerFeePercent: 5 });

    const data = update.mock.calls[0][0].data;
    expect('retentionRate' in data).toBe(false);
    expect('refundFeeRate' in data).toBe(false);
    expect(data.organizerFeePercent).toBe(5);
  });

  it('seleciona retentionRate/refundFeeRate no update (expõe pro painel)', async () => {
    const { service, update } = build();

    await service.updateFinancialSettings('evt-1', { refundFeeRate: 0.02 });

    const select = update.mock.calls[0][0].select;
    expect(select.retentionRate).toBe(true);
    expect(select.refundFeeRate).toBe(true);
  });
});
