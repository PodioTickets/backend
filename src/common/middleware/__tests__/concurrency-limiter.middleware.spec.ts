/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: o "limitador de requisições simultâneas" — protege o servidor contra
 *           uma mesma pessoa (ou IP) disparar muitas requisições ao mesmo tempo.
 *
 *  O BUG QUE ISSO CORRIGE:
 *    Antes, o limitador agrupava as pessoas pelo `req.ip`. Atrás de um proxy/load
 *    balancer (produção), o `req.ip` é o IP do PRÓPRIO proxy — igual para todo mundo.
 *    Resultado: TODOS os usuários caíam no mesmo "balde" e o limite virava um teto
 *    GLOBAL minúsculo → erro 429 "Too many concurrent requests" o tempo todo.
 *
 *  O QUE PASSA A VALER (cada item é um teste aqui embaixo):
 *    • Usuário logado é identificado pelo SEU token (não pelo IP) → balde por pessoa.
 *    • Dois usuários logados diferentes NÃO compartilham o mesmo limite.
 *    • Anônimo é identificado pelo IP REAL do cliente (x-forwarded-for), não pelo proxy.
 *    • Estourar o limite do mesmo identificador retorna 429.
 *    • Ao terminar a requisição, o "slot" é liberado e a próxima passa.
 *    • GET/HEAD/OPTIONS não contam (passam direto).
 *
 *  Em ambiente de teste o limite é 1 (produção = 50), o que facilita exercitar o estouro.
 * ============================================================================
 */
import { JwtService } from '@nestjs/jwt';
import { ConcurrencyLimiterMiddleware } from '../concurrency-limiter.middleware';

const SECRET = 'test-secret-para-o-limitador';

// req/res falsos mínimos para exercitar o middleware como o Express faria.
function makeRes() {
  const handlers: Record<string, () => void> = {};
  const res: any = {
    statusCode: 200,
    body: undefined,
    status: jest.fn().mockImplementation((c: number) => { res.statusCode = c; return res; }),
    json: jest.fn().mockImplementation((b: any) => { res.body = b; return res; }),
    once: jest.fn().mockImplementation((ev: string, cb: () => void) => { handlers[ev] = cb; return res; }),
    on: jest.fn().mockImplementation((ev: string, cb: () => void) => { handlers[ev] = cb; return res; }),
    finish: () => handlers['finish']?.(),
  };
  return res;
}
const makeReq = (over: any = {}) => ({ method: 'POST', headers: {}, ...over });

describe('ConcurrencyLimiterMiddleware (identificador por usuário/IP)', () => {
  let mw: ConcurrencyLimiterMiddleware;
  let jwt: JwtService;

  beforeAll(() => {
    process.env.JWT_SECRET = SECRET; // lido no construtor do middleware
    jwt = new JwtService({ secret: SECRET });
  });

  beforeEach(() => {
    // Fake timers: o caminho in-memory agenda um setTimeout(30s) de auto-release por request.
    // Sem isso, requests que não disparam `res.finish()` (ex.: a barrada com 429) deixariam o
    // timer real pendente → open handle no Jest. Não avançamos o relógio: o release é controlado
    // pelo `res.finish()` nos testes que precisam dele.
    jest.useFakeTimers();
    mw = new ConcurrencyLimiterMiddleware(); // sem Redis → caminho in-memory
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const tokenFor = (sub: string) => `Bearer ${jwt.sign({ sub })}`;

  it('GET passa direto (não conta no limite)', async () => {
    const next = jest.fn();
    const res = makeRes();
    await mw.use(makeReq({ method: 'GET' }) as any, res as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('mesmo usuário logado: 2ª requisição simultânea → 429', async () => {
    const auth = tokenFor('user-A');
    const next1 = jest.fn();
    const next2 = jest.fn();

    await mw.use(makeReq({ headers: { authorization: auth } }) as any, makeRes() as any, next1);
    const res2 = makeRes();
    await mw.use(makeReq({ headers: { authorization: auth } }) as any, res2 as any, next2);

    expect(next1).toHaveBeenCalledTimes(1); // 1ª passou
    expect(next2).not.toHaveBeenCalled();   // 2ª barrada
    expect(res2.statusCode).toBe(429);
    expect(res2.body.message).toMatch(/concurrent/i);
  });

  it('usuários logados DIFERENTES não compartilham o limite', async () => {
    const nextA = jest.fn();
    const nextB = jest.fn();

    await mw.use(makeReq({ headers: { authorization: tokenFor('user-A') } }) as any, makeRes() as any, nextA);
    const resB = makeRes();
    await mw.use(makeReq({ headers: { authorization: tokenFor('user-B') } }) as any, resB as any, nextB);

    expect(nextA).toHaveBeenCalledTimes(1);
    expect(nextB).toHaveBeenCalledTimes(1); // bucket separado → passa
    expect(resB.status).not.toHaveBeenCalled();
  });

  it('liberar o slot (res finish) deixa a próxima do mesmo usuário passar', async () => {
    const auth = tokenFor('user-A');
    const res1 = makeRes();
    const next1 = jest.fn();
    await mw.use(makeReq({ headers: { authorization: auth } }) as any, res1 as any, next1);
    res1.finish(); // request terminou → libera o slot

    const next2 = jest.fn();
    const res2 = makeRes();
    await mw.use(makeReq({ headers: { authorization: auth } }) as any, res2 as any, next2);

    expect(next2).toHaveBeenCalledTimes(1); // slot livre → passa
    expect(res2.status).not.toHaveBeenCalled();
  });

  it('anônimo é bucketado pelo IP REAL (x-forwarded-for), não pelo IP do proxy (req.ip)', async () => {
    // Dois clientes reais distintos atrás do MESMO proxy: req.ip igual, XFF diferente.
    const proxyIp = '10.0.0.1';
    const reqClient1 = makeReq({ ip: proxyIp, headers: { 'x-forwarded-for': '200.1.1.1' } });
    const reqClient2 = makeReq({ ip: proxyIp, headers: { 'x-forwarded-for': '200.2.2.2' } });

    const next1 = jest.fn();
    const next2 = jest.fn();
    await mw.use(reqClient1 as any, makeRes() as any, next1);
    const res2 = makeRes();
    await mw.use(reqClient2 as any, res2 as any, next2);

    // Se ainda usasse req.ip, os dois colidiriam e o 2º tomaria 429. Com XFF, passam os dois.
    expect(next1).toHaveBeenCalledTimes(1);
    expect(next2).toHaveBeenCalledTimes(1);
    expect(res2.status).not.toHaveBeenCalled();
  });

  it('token forjado (assinatura inválida) NÃO cria bucket de usuário → cai no IP', async () => {
    const forged = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJoYWNrZXIifQ.assinatura_invalida';
    const ip = '203.0.113.9';
    const next1 = jest.fn();
    const next2 = jest.fn();

    // 1ª com token forjado → identificada pelo IP.
    await mw.use(makeReq({ ip, headers: { authorization: forged } }) as any, makeRes() as any, next1);
    // 2ª do MESMO IP (token forjado) → mesmo bucket de IP → 429 (não furou o limite).
    const res2 = makeRes();
    await mw.use(makeReq({ ip, headers: { authorization: forged } }) as any, res2 as any, next2);

    expect(next1).toHaveBeenCalledTimes(1);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(429);
  });
});
