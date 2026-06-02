/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: o "diário de alterações" do produto — registra o que mudou quando o
 *           organizador edita um produto (camiseta, etc.) e suas variações (tamanhos).
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Registra só os campos que mudaram, com rótulo em português.
 *    • Campo igual (mesmo valor) não conta como mudança.
 *    • Quando as variações são enviadas, registra a troca (de/para).
 *
 *  COMO CONFERIMOS:
 *    Conta pura: passamos o "antes" e a edição e conferimos a lista de mudanças. Sem banco.
 * ============================================================================
 */
import { summarizeProductUpdateForAudit } from '../product-audit.helpers';

const before: any = {
  name: 'Camiseta',
  basePrice: 1000,
  isRequired: false,
  variations: [{ id: 'v1', name: 'P', price: 0, stock: 10 }],
};

describe('summarizeProductUpdateForAudit', () => {
  it('registra mudança de campo com rótulo legível', () => {
    const { labels, changes } = summarizeProductUpdateForAudit(before, { name: 'Camiseta Oficial' }, {} as any);
    expect(labels).toContain('nome');
    expect(changes).toContainEqual({ field: 'name', old: 'Camiseta', new: 'Camiseta Oficial' });
  });

  it('campo com o mesmo valor não vira mudança', () => {
    const { changes } = summarizeProductUpdateForAudit(before, { name: 'Camiseta' }, {} as any);
    expect(changes).toEqual([]);
  });

  it('mudança de booleano (obrigatório) é detectada', () => {
    const { labels } = summarizeProductUpdateForAudit(before, { isRequired: true }, {} as any);
    expect(labels).toContain('obrigatório');
  });

  it('registra troca de variações quando enviadas', () => {
    const novas = [{ name: 'M', price: 0, stock: 5 }];
    const { labels, changes } = summarizeProductUpdateForAudit(before, {}, { variations: novas } as any, novas);
    expect(labels).toContain('variações');
    const v = changes.find((c) => c.field === 'variations')!;
    expect(v.old).toEqual([{ name: 'P', price: 0, stock: 10 }]);
    expect(v.new).toEqual(novas);
  });

  it('não registra variações quando não foram enviadas', () => {
    const { changes } = summarizeProductUpdateForAudit(before, { name: 'X' }, {} as any);
    expect(changes.find((c) => c.field === 'variations')).toBeUndefined();
  });
});
