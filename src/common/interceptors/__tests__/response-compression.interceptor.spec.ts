/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: a "faxina" automática das respostas da API. Antes de enviar a resposta, o
 *           sistema remove campos vazios (nulos ou em branco) e padroniza datas.
 *
 *  EM RESUMO:
 *    Isso deixa a resposta mais enxuta. ATENÇÃO: como ele apaga campos vazios, um campo
 *    "que não veio" pro front muitas vezes é só um campo que estava vazio e foi removido aqui.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Remove campos nulos, indefinidos e em branco.
 *    • Mantém listas vazias (não as apaga).
 *    • Mantém as datas de criação/atualização mesmo vazias.
 *    • Converte datas para texto padronizado (ISO).
 *    • Listas muito grandes (mais de 100) são cortadas para 50 com aviso de "tem mais".
 *
 *  COMO CONFERIMOS:
 *    Passamos respostas de exemplo pela faxina e conferimos o que sai. Conta pura — sem banco.
 * ============================================================================
 */
import { lastValueFrom, of } from 'rxjs';
import { ResponseCompressionInterceptor } from '../response-compression.interceptor';

const run = (data: any) => {
  const interceptor = new ResponseCompressionInterceptor();
  const next: any = { handle: () => of(data) };
  return lastValueFrom(interceptor.intercept({} as any, next));
};

describe('ResponseCompressionInterceptor', () => {
  it('remove campos nulos, indefinidos e em branco', async () => {
    const out = await run({ a: 1, vazio: '', nulo: null, indef: undefined, ok: 'x' });
    expect(out).toEqual({ a: 1, ok: 'x' });
  });

  it('mantém listas vazias', async () => {
    const out = await run({ itens: [] });
    expect(out).toEqual({ itens: [] });
  });

  it('mantém createdAt/updatedAt mesmo vazios', async () => {
    const out = await run({ createdAt: null, updatedAt: null, x: null });
    expect(out).toHaveProperty('createdAt', null);
    expect(out).toHaveProperty('updatedAt', null);
    expect(out).not.toHaveProperty('x');
  });

  it('converte data para texto ISO', async () => {
    const out = await run({ when: new Date('2026-06-02T00:00:00.000Z') });
    expect(out.when).toBe('2026-06-02T00:00:00.000Z');
  });

  it('remove objeto aninhado que ficou vazio', async () => {
    const out = await run({ meta: { so_nulo: null } });
    expect(out).not.toHaveProperty('meta');
  });

  it('lista grande (>100) é cortada para 50 com aviso de "tem mais"', async () => {
    const grande = Array.from({ length: 120 }, (_, i) => ({ i }));
    const out = await run(grande);
    expect(out.hasMore).toBe(true);
    expect(out.total).toBe(120);
    expect(out.data).toHaveLength(50);
  });
});
