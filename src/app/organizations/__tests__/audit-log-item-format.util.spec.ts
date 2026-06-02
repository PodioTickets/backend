/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: como o item do histórico de auditoria é exibido — separa o TEXTO da ação
 *           (ex.: "Editou o evento X") dos CAMPOS alterados (ex.: "nome, banner").
 *
 *  EM RESUMO:
 *    Registros novos guardam a lista de campos editados à parte; registros antigos embutiam
 *    "(nome, banner)" no fim do texto. Esta peça normaliza os dois para a mesma exibição.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Edição de evento: traduz os campos editados para rótulos em português.
 *    • Edição de ingresso/produto: lista os campos editados.
 *    • Registro antigo com "(...)" no fim do texto: extrai os campos e limpa o texto.
 *    • Registro que não é de edição: passa direto, sem campos.
 *
 *  COMO CONFERIMOS:
 *    Conta pura: passamos o texto + metadata e conferimos a exibição. Sem banco.
 * ============================================================================
 */
import { formatAuditLogItemForResponse } from '../audit-log-item-format.util';

describe('formatAuditLogItemForResponse', () => {
  it('EVENT_UPDATE: traduz os campos editados para rótulos', () => {
    const out = formatAuditLogItemForResponse('Editou o evento "Corrida"', {
      kind: 'EVENT_UPDATE',
      fieldsEdited: ['name', 'bannerUrl'],
    });
    expect(out.action).toBe('Editou o evento "Corrida"');
    expect(out.editedFields).toBe('nome, banner');
  });

  it('TICKET_UPDATE: lista os campos editados', () => {
    const out = formatAuditLogItemForResponse('Editou o ingresso "Lote 1"', {
      kind: 'TICKET_UPDATE',
      fieldsEdited: ['nome', 'lotes'],
    });
    expect(out.editedFields).toBe('nome, lotes');
  });

  it('registro antigo com "(...)" no fim: extrai os campos e limpa o texto', () => {
    const out = formatAuditLogItemForResponse('Editou o evento "Corrida" (nome, banner)', {});
    expect(out.action).toBe('Editou o evento "Corrida"');
    expect(out.editedFields).toBe('nome, banner');
  });

  it('registro que não é de edição passa direto, sem campos', () => {
    const out = formatAuditLogItemForResponse('Fez login', { kind: 'LOGIN' });
    expect(out).toEqual({ action: 'Fez login', editedFields: null });
  });
});
