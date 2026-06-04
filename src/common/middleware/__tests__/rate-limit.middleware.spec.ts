/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: o "limitador de taxa" (rate limit) — protege a API contra um mesmo
 *           cliente disparar requisições demais dentro de uma janela de tempo.
 *
 *  COMO FUNCIONA (comportamento real do middleware):
 *    • O cliente é identificado por `IP:user-agent`.
 *    • O IP é extraído com prioridade: `req.ip` → `x-forwarded-for` (1º da lista)
 *      → `x-real-ip` → `connection.remoteAddress` → `socket.remoteAddress` → 'unknown'.
 *    • O tipo do endpoint é deduzido do PATH e define o teto + a janela:
 *        - /api/v1/auth            → auth     (10 req / 15min)
 *        - /api/v1/upload          → upload   (50 req / 60min)
 *        - /api/v1/balance/deposit → deposits (10 req / 60min)
 *        - /admin | /api/v1/user | /api/v1/lootbox → admin (200 req / 60min)
 *        - qualquer outro          → api      (100 req / 15min)
 *    • Dentro do teto: chama next() e seta headers X-RateLimit-*.
 *    • Estourou o teto: lança HttpException 429 (TOO_MANY_REQUESTS) e NÃO chama next().
 *    • Passada a janela (now > resetTime): o balde reseta e a contagem recomeça em 1.
 *
 *  Usamos fake timers + setSystemTime para controlar o "relógio" (Date.now()),
 *  permitindo exercitar o reset de janela de forma determinística.
 * ============================================================================
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { RateLimitMiddleware } from '../rate-limit.middleware';

// req/res falsos mínimos para exercitar o middleware como o Express faria.
function makeRes() {
  const headers: Record<string, any> = {};
  const res: any = {
    headers,
    setHeader: jest.fn().mockImplementation((k: string, v: any) => {
      headers[k] = v;
      return res;
    }),
  };
  return res;
}

const makeReq = (over: any = {}) => ({
  path: '/api/v1/something',
  ip: '1.2.3.4',
  headers: { 'user-agent': 'jest-agent' },
  ...over,
});

// Dispara o middleware e devolve o erro capturado (ou null se passou).
function run(mw: RateLimitMiddleware, req: any, res: any) {
  const next = jest.fn();
  let error: any = null;
  try {
    mw.use(req as any, res as any, next);
  } catch (e) {
    error = e;
  }
  return { next, error };
}

describe('RateLimitMiddleware (limitador de taxa por IP:user-agent)', () => {
  let mw: RateLimitMiddleware;

  beforeEach(() => {
    // Relógio fixo e controlável → reset de janela determinístico.
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-03T12:00:00.000Z'));
    mw = new RateLimitMiddleware();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('requisição dentro do limite passa (chama next, sem erro)', () => {
    const { next, error } = run(mw, makeReq(), makeRes());
    expect(error).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('seta os headers X-RateLimit-* na resposta dentro do limite', () => {
    const res = makeRes();
    run(mw, makeReq(), res);
    // endpoint 'api' → teto 100; 1ª requisição → count=1 → remaining=99.
    expect(res.headers['X-RateLimit-Limit']).toBe(100);
    expect(res.headers['X-RateLimit-Remaining']).toBe(99);
    expect(typeof res.headers['X-RateLimit-Reset']).toBe('number');
  });

  it('várias requisições abaixo do teto continuam passando e decrementam o remaining', () => {
    const ua = 'agent-decremento';
    let lastRes = makeRes();
    for (let i = 0; i < 5; i++) {
      lastRes = makeRes();
      const { next, error } = run(
        mw,
        makeReq({ headers: { 'user-agent': ua } }),
        lastRes,
      );
      expect(error).toBeNull();
      expect(next).toHaveBeenCalledTimes(1);
    }
    // Endpoint 'api' (teto 100): após 5 requisições, count=5 → remaining=95.
    expect(lastRes.headers['X-RateLimit-Remaining']).toBe(95);
  });

  it('excedente é barrado com HttpException 429 e NÃO chama next', () => {
    // Endpoint 'deposits' → teto 10 (baixo, fácil de estourar).
    const req = () =>
      makeReq({ path: '/api/v1/balance/deposit', headers: { 'user-agent': 'dep' } });

    // As 10 primeiras passam.
    for (let i = 0; i < 10; i++) {
      const { next, error } = run(mw, req(), makeRes());
      expect(error).toBeNull();
      expect(next).toHaveBeenCalledTimes(1);
    }

    // A 11ª estoura.
    const { next, error } = run(mw, req(), makeRes());
    expect(next).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);

    const body = error.getResponse();
    expect(body.statusCode).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(body.error).toBe('RATE_LIMIT_EXCEEDED');
    expect(body.message).toMatch(/too many requests/i);
    expect(typeof body.retryAfter).toBe('number');
  });

  it('reseta a contagem quando a janela de tempo expira (next volta a passar)', () => {
    const req = () =>
      makeReq({ path: '/api/v1/balance/deposit', headers: { 'user-agent': 'janela' } });

    // Estoura o teto de 10 da janela atual.
    for (let i = 0; i < 10; i++) run(mw, req(), makeRes());
    const barrado = run(mw, req(), makeRes());
    expect(barrado.error).toBeInstanceOf(HttpException);

    // 'deposits' tem janela de 60min. Avança o relógio além disso.
    jest.setSystemTime(new Date('2026-06-03T13:00:01.000Z'));

    const liberado = run(mw, req(), makeRes());
    expect(liberado.error).toBeNull();
    expect(liberado.next).toHaveBeenCalledTimes(1);
  });

  it('identificadores diferentes (user-agent distinto) têm baldes separados', () => {
    const reqA = () =>
      makeReq({ path: '/api/v1/balance/deposit', headers: { 'user-agent': 'cliente-A' } });
    const reqB = () =>
      makeReq({ path: '/api/v1/balance/deposit', headers: { 'user-agent': 'cliente-B' } });

    // Esgota o balde do cliente A (teto 10).
    for (let i = 0; i < 10; i++) run(mw, reqA(), makeRes());
    expect(run(mw, reqA(), makeRes()).error).toBeInstanceOf(HttpException);

    // Cliente B (mesmo IP, UA diferente) continua livre.
    const b = run(mw, reqB(), makeRes());
    expect(b.error).toBeNull();
    expect(b.next).toHaveBeenCalledTimes(1);
  });

  it('IPs diferentes (mesmo user-agent) têm baldes separados', () => {
    const ua = 'mesmo-ua';
    const reqIp1 = () =>
      makeReq({ ip: '10.0.0.1', path: '/api/v1/balance/deposit', headers: { 'user-agent': ua } });
    const reqIp2 = () =>
      makeReq({ ip: '10.0.0.2', path: '/api/v1/balance/deposit', headers: { 'user-agent': ua } });

    for (let i = 0; i < 10; i++) run(mw, reqIp1(), makeRes());
    expect(run(mw, reqIp1(), makeRes()).error).toBeInstanceOf(HttpException);

    const segundoIp = run(mw, reqIp2(), makeRes());
    expect(segundoIp.error).toBeNull();
  });

  it('identifica o cliente por x-forwarded-for quando req.ip está ausente', () => {
    // Sem req.ip → cai no 1º IP do x-forwarded-for.
    const headers = { 'user-agent': 'xff-ua', 'x-forwarded-for': '200.1.1.1, 10.0.0.1' };
    const reqXff = () =>
      makeReq({ ip: undefined, path: '/api/v1/balance/deposit', headers });

    for (let i = 0; i < 10; i++) run(mw, reqXff(), makeRes());
    const barrado = run(mw, reqXff(), makeRes());
    expect(barrado.error).toBeInstanceOf(HttpException);

    // Mesmo XFF → mesmo balde → continua barrado (confirma que o XFF foi a chave).
    const stats = mw.getStats();
    expect(stats.entries.some((e) => e.identifier.startsWith('200.1.1.1:'))).toBe(true);
  });

  it("usa 'unknown' como IP quando nenhuma fonte de IP está disponível", () => {
    const reqSemIp = makeReq({
      ip: undefined,
      connection: undefined,
      socket: undefined,
      headers: { 'user-agent': 'sem-ip' },
    });
    run(mw, reqSemIp, makeRes());
    const stats = mw.getStats();
    expect(stats.entries.some((e) => e.identifier === 'unknown:sem-ip')).toBe(true);
  });

  it("usa user-agent 'unknown' quando o header não é enviado", () => {
    const reqSemUa = makeReq({ ip: '5.5.5.5', headers: {} });
    run(mw, reqSemUa, makeRes());
    const stats = mw.getStats();
    expect(stats.entries.some((e) => e.identifier === '5.5.5.5:unknown')).toBe(true);
  });

  it('classifica o tipo de endpoint pelo path (auth tem teto 10, api tem teto 100)', () => {
    // /api/v1/auth → 'auth' (teto 10). 11ª estoura.
    const reqAuth = () =>
      makeReq({ path: '/api/v1/auth/login', headers: { 'user-agent': 'auth-ua' } });
    for (let i = 0; i < 10; i++) run(mw, reqAuth(), makeRes());
    expect(run(mw, reqAuth(), makeRes()).error).toBeInstanceOf(HttpException);

    // Confirma o teto exposto nos headers para um endpoint 'api' (100).
    const resApi = makeRes();
    run(mw, makeReq({ path: '/api/v1/whatever', headers: { 'user-agent': 'api-ua' } }), resApi);
    expect(resApi.headers['X-RateLimit-Limit']).toBe(100);
  });

  it('endpoints admin (/api/v1/user, /admin, /api/v1/lootbox) usam teto 200', () => {
    for (const path of ['/api/v1/user/me', '/some/admin/panel', '/api/v1/lootbox/open']) {
      const res = makeRes();
      run(mw, makeReq({ path, headers: { 'user-agent': `ua-${path}` } }), res);
      expect(res.headers['X-RateLimit-Limit']).toBe(200);
    }
  });

  it('cleanup() remove entradas com janela expirada', () => {
    run(mw, makeReq({ headers: { 'user-agent': 'cleanup-ua' } }), makeRes());
    expect(mw.getStats().totalEntries).toBe(1);

    // Avança além da janela 'api' (15min) e limpa.
    jest.setSystemTime(new Date('2026-06-03T12:20:00.000Z'));
    mw.cleanup();
    expect(mw.getStats().totalEntries).toBe(0);
  });
});
