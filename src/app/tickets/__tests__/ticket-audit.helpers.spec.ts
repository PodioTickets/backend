/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: o "diário de alterações" do ingresso — registra o que mudou quando o
 *           organizador edita um ingresso (campos, lotes e produtos vinculados).
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Registra os campos alterados com rótulo em português (ex.: "nome").
 *    • Quando os lotes são enviados, registra a troca de lotes.
 *    • Quando os produtos vinculados são enviados, registra a troca de produtos.
 *
 *  COMO CONFERIMOS:
 *    Conta pura: passamos o "antes" e a edição e conferimos a lista de mudanças. Sem banco.
 * ============================================================================
 */
import { summarizeTicketUpdateForAudit } from '../ticket-audit.helpers';

const before: any = {
  name: 'Lote 1',
  modality: 'Corrida',
  products: [{ productId: 'p-antigo' }],
  batches: [{ id: 'b1', quantity: 100, price: 5000, startDate: null, endDate: null }],
};

describe('summarizeTicketUpdateForAudit', () => {
  it('registra mudança de campo com rótulo legível', () => {
    const { labels } = summarizeTicketUpdateForAudit(before, { name: 'Lote Promocional' }, {} as any);
    expect(labels).toContain('nome');
  });

  it('registra a troca de lotes quando enviados', () => {
    const dto: any = { batches: [{ quantity: 50, price: 4000 }] };
    const { labels, changes } = summarizeTicketUpdateForAudit(before, {}, dto);
    expect(labels).toContain('lotes');
    expect(changes.find((c) => c.field === 'batches')).toBeDefined();
  });

  it('registra a troca de produtos vinculados quando enviados', () => {
    const dto: any = { productIds: ['p-novo'] };
    const { labels, changes } = summarizeTicketUpdateForAudit(before, {}, dto);
    expect(labels).toContain('produtos vinculados');
    const c = changes.find((x) => x.field === 'productIds')!;
    expect(c.old).toEqual(['p-antigo']);
    expect(c.new).toEqual(['p-novo']);
  });
});
