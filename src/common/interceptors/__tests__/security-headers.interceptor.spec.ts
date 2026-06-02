/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: a "camada de segurança" que o sistema coloca em TODA resposta enviada
 *           para o navegador do usuário.
 *
 *  EM RESUMO:
 *    Sempre que o site responde algo, ele adiciona automaticamente travas de segurança
 *    (ex.: impedir que a página seja aberta dentro de outro site) e, por padrão, manda o
 *    navegador NÃO guardar a resposta em cache. Algumas telas com conteúdo fixo (ex.: a
 *    lista de estados/cidades) podem pedir para guardar em cache — e aí o sistema respeita.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • As travas de segurança são colocadas em toda resposta.
 *    • Por padrão, a resposta é marcada como "não guardar em cache".
 *    • Se a tela pediu para guardar em cache, o sistema NÃO sobrescreve esse pedido.
 *    • Se a resposta já saiu, o sistema não tenta mexer nela de novo.
 *
 *  COMO CONFERIMOS:
 *    Simulamos uma resposta saindo do sistema e conferimos quais "carimbos" de segurança
 *    e de cache foram colocados nela.
 * ============================================================================
 */
import { lastValueFrom, of } from 'rxjs';
import { SecurityHeadersInterceptor } from '../security-headers.interceptor';

function makeResponse(init: { cacheControl?: string; headersSent?: boolean; finished?: boolean } = {}) {
  const headers: Record<string, any> = {};
  if (init.cacheControl) headers['Cache-Control'] = init.cacheControl;
  return {
    headersSent: init.headersSent ?? false,
    finished: init.finished ?? false,
    setHeader: jest.fn((k: string, v: any) => {
      headers[k] = v;
    }),
    getHeader: jest.fn((k: string) => headers[k]),
    _headers: headers,
  };
}

const ctxFor = (response: any): any => ({
  switchToHttp: () => ({ getResponse: () => response }),
});
const nextWith = (data: any = 'ok'): any => ({ handle: () => of(data) });

describe('SecurityHeadersInterceptor', () => {
  let interceptor: SecurityHeadersInterceptor;

  beforeEach(() => {
    interceptor = new SecurityHeadersInterceptor();
  });

  it('coloca as travas de segurança na resposta', async () => {
    const res = makeResponse();
    await lastValueFrom(interceptor.intercept(ctxFor(res), nextWith()));

    expect(res._headers['X-Frame-Options']).toBe('DENY');
    expect(res._headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res._headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(res._headers['Content-Security-Policy']).toContain("frame-ancestors 'self'");
  });

  it('marca a resposta como "não guardar em cache" por padrão', async () => {
    const res = makeResponse();
    await lastValueFrom(interceptor.intercept(ctxFor(res), nextWith()));

    expect(res._headers['Cache-Control']).toBe('no-store, no-cache, must-revalidate');
  });

  it('respeita o pedido de cache quando a tela já definiu um', async () => {
    const res = makeResponse({ cacheControl: 'public, max-age=86400' });
    await lastValueFrom(interceptor.intercept(ctxFor(res), nextWith()));

    expect(res._headers['Cache-Control']).toBe('public, max-age=86400');
  });

  it('não mexe na resposta se ela já foi enviada', async () => {
    const res = makeResponse({ headersSent: true });
    await lastValueFrom(interceptor.intercept(ctxFor(res), nextWith()));

    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('não altera o conteúdo da resposta', async () => {
    const res = makeResponse();
    const out = await lastValueFrom(interceptor.intercept(ctxFor(res), nextWith({ ok: 1 })));
    expect(out).toEqual({ ok: 1 });
  });
});
