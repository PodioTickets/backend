/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: o detalhamento "de/para" de cada alteração no histórico de auditoria,
 *           que aparece para o admin/suporte (ex.: "nome: de X para Y").
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Sem alterações registradas → não mostra detalhamento (nulo).
 *    • Traduz o nome do campo conforme o tipo do registro (evento, ingresso, produto, etc.).
 *    • Ignora entradas malformadas.
 *
 *  COMO CONFERIMOS:
 *    Conta pura: passamos o "metadata" do registro e conferimos o detalhamento. Sem banco.
 * ============================================================================
 */
import { buildAuditChangeDetails } from '../audit-log-change-details.util';

describe('buildAuditChangeDetails', () => {
  it('sem changes → nulo', () => {
    expect(buildAuditChangeDetails({ kind: 'EVENT_UPDATE' })).toBeNull();
    expect(buildAuditChangeDetails(null)).toBeNull();
    expect(buildAuditChangeDetails({ changes: [] })).toBeNull();
  });

  it('traduz o campo conforme o tipo EVENT_UPDATE', () => {
    const out = buildAuditChangeDetails({
      kind: 'EVENT_UPDATE',
      changes: [{ field: 'eventDate', old: 'a', new: 'b' }],
    });
    expect(out).toEqual([
      { field: 'eventDate', fieldLabel: 'data do evento', oldValue: 'a', newValue: 'b' },
    ]);
  });

  it('usa rótulos da organização quando o tipo não é de edição conhecida', () => {
    const out = buildAuditChangeDetails({
      changes: [{ field: 'role', old: 'EMPLOYEE', new: 'OWNER' }],
    });
    expect(out![0].fieldLabel).toBe('papel');
  });

  it('ignora entradas malformadas (sem field/old/new)', () => {
    const out = buildAuditChangeDetails({
      kind: 'EVENT_UPDATE',
      changes: [{ nope: 1 }, { field: 'name', old: 'x', new: 'y' }],
    });
    expect(out).toHaveLength(1);
    expect(out![0].field).toBe('name');
  });
});
