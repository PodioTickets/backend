/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: o "diário de alterações" do evento — quando o organizador edita o evento,
 *           o sistema registra o que mudou (de/para) para aparecer no histórico.
 *
 *  EM RESUMO:
 *    Ao salvar uma edição, comparamos o que veio com o que estava e guardamos só os campos
 *    que REALMENTE mudaram, com rótulos legíveis (ex.: "data do evento", "local").
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Só registra os campos que mudaram (ignora os que ficaram iguais).
 *    • Datas iguais não contam como mudança; datas diferentes são registradas como data.
 *    • Traduz os nomes técnicos dos campos para rótulos em português.
 *
 *  COMO CONFERIMOS:
 *    Contas puras: passamos o "antes" e a edição e conferimos a lista de mudanças. Sem banco.
 * ============================================================================
 */
import {
  serializeAuditValue,
  diffEventUpdateForAudit,
  diffEventUpdateAgainstData,
  summarizeEventFieldChanges,
} from '../event-audit.helpers';

describe('serializeAuditValue', () => {
  it('converte data para texto ISO', () => {
    expect(serializeAuditValue(new Date('2026-06-02T00:00:00.000Z'))).toBe('2026-06-02T00:00:00.000Z');
  });
  it('mantém valores não-data como estão', () => {
    expect(serializeAuditValue('texto')).toBe('texto');
    expect(serializeAuditValue(42)).toBe(42);
  });
});

describe('diffEventUpdateForAudit', () => {
  const before: any = { name: 'Corrida', city: 'São Paulo', eventDate: new Date('2026-06-10T00:00:00.000Z') };

  it('registra só o campo que mudou', () => {
    const changes = diffEventUpdateForAudit(before, { name: 'Corrida 2026' } as any);
    expect(changes).toEqual([{ field: 'name', old: 'Corrida', new: 'Corrida 2026' }]);
  });

  it('ignora campo enviado igual ao atual', () => {
    expect(diffEventUpdateForAudit(before, { city: 'São Paulo' } as any)).toEqual([]);
  });

  it('data igual não conta; data diferente é registrada', () => {
    expect(diffEventUpdateForAudit(before, { eventDate: '2026-06-10T00:00:00.000Z' } as any)).toEqual([]);
    const changes = diffEventUpdateForAudit(before, { eventDate: '2026-07-01T00:00:00.000Z' } as any);
    expect(changes[0].field).toBe('eventDate');
    expect(changes[0].new).toBe('2026-07-01T00:00:00.000Z');
  });
});

describe('diffEventUpdateAgainstData', () => {
  it('compara a exibição do kit (JSON) e registra quando muda', () => {
    const before: any = { kitSelectionDisplay: null };
    const changes = diffEventUpdateAgainstData(before, { kitSelectionDisplay: { a: 1 } });
    expect(changes[0].field).toBe('kitSelectionDisplay');
  });

  it('JSON igual não conta como mudança', () => {
    const before: any = { kitSelectionDisplay: { a: 1 } };
    expect(diffEventUpdateAgainstData(before, { kitSelectionDisplay: { a: 1 } })).toEqual([]);
  });
});

describe('summarizeEventFieldChanges', () => {
  it('junta os rótulos em português', () => {
    expect(
      summarizeEventFieldChanges([{ field: 'name' }, { field: 'eventDate' }] as any),
    ).toBe('nome, data do evento');
  });
  it('lista vazia → texto vazio', () => {
    expect(summarizeEventFieldChanges([])).toBe('');
  });
});
