/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: o "monitor de performance de requisições" — um middleware que
 *           cronometra quanto tempo cada requisição HTTP levou e, quando ela
 *           termina, entrega essa medição para o serviço de monitoramento
 *           (que depois agrega tudo: latência média, p95, rotas mais lentas...).
 *
 *  COMO ELE FUNCIONA (e o que cobrimos aqui embaixo):
 *    • Ele marca o instante de início (process.hrtime) quando a requisição chega.
 *    • Ele NÃO segura a requisição: chama `next()` na hora, sempre.
 *    • Ele se inscreve no evento `finish` da resposta. SÓ quando a resposta
 *      termina é que ele calcula a duração e chama `recordRequest(...)` no
 *      serviço, passando método, rota, status HTTP e duração em ms.
 *    • A "rota" registrada usa `req.originalUrl`, caindo para `req.url` e por
 *      fim `'/'` quando nenhum dos dois existe.
 *
 *  IMPORTANTE (escopo real):
 *    • Quem decide IGNORAR rota (ex.: /api/v1/health/performance) é o SERVIÇO,
 *      dentro de `recordRequest`, NÃO o middleware. Logo o middleware sempre
 *      chama `recordRequest` — e é exatamente isso que validamos aqui (não
 *      testamos comportamento do serviço, que é mockado).
 *    • O middleware NÃO envolve `recordRequest` em try/catch. Ver o último
 *      bloco de teste, que documenta esse comportamento real.
 * ============================================================================
 */
import { PerformanceMonitoringMiddleware } from '../performance-monitoring.middleware';
import { PerformanceMonitorService } from '../../services/performance-monitor.service';

// Service mockado: só nos interessa observar a chamada de `recordRequest`.
function makeMonitor() {
  return { recordRequest: jest.fn() } as unknown as PerformanceMonitorService & {
    recordRequest: jest.Mock;
  };
}

// res falso mínimo: guarda o handler de `finish` e expõe um gatilho `finish()`
// para simular o término da resposta como o Express faria.
function makeRes(over: any = {}) {
  const handlers: Record<string, () => void> = {};
  const res: any = {
    statusCode: 200,
    on: jest.fn().mockImplementation((ev: string, cb: () => void) => {
      handlers[ev] = cb;
      return res;
    }),
    finish: () => handlers['finish']?.(),
    ...over,
  };
  return res;
}

const makeReq = (over: any = {}) => ({ method: 'POST', originalUrl: '/api/v1/orders', ...over });

describe('PerformanceMonitoringMiddleware (cronometra requisições e reporta ao monitor)', () => {
  let mw: PerformanceMonitoringMiddleware;
  let monitor: ReturnType<typeof makeMonitor>;

  beforeEach(() => {
    monitor = makeMonitor();
    mw = new PerformanceMonitoringMiddleware(monitor);
  });

  it('chama next() imediatamente (não segura a requisição)', () => {
    const next = jest.fn();
    mw.use(makeReq() as any, makeRes() as any, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('NÃO registra a métrica antes de a resposta terminar (só no evento finish)', () => {
    const next = jest.fn();
    mw.use(makeReq() as any, makeRes() as any, next);
    // Sem disparar `finish`, nada deve ter sido reportado ainda.
    expect(monitor.recordRequest).not.toHaveBeenCalled();
  });

  it('ao finalizar a resposta, registra método, rota, status e duração', () => {
    const next = jest.fn();
    const req = makeReq({ method: 'POST', originalUrl: '/api/v1/orders' });
    const res = makeRes({ statusCode: 201 });

    mw.use(req as any, res as any, next);
    res.finish(); // resposta terminou → dispara o registro

    expect(monitor.recordRequest).toHaveBeenCalledTimes(1);
    const sample = monitor.recordRequest.mock.calls[0][0];
    expect(sample.method).toBe('POST');
    expect(sample.path).toBe('/api/v1/orders');
    expect(sample.statusCode).toBe(201);
    expect(typeof sample.durationMs).toBe('number');
    expect(sample.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('lê o statusCode no momento do finish (não no momento da chamada)', () => {
    const next = jest.fn();
    const res = makeRes({ statusCode: 200 });

    mw.use(makeReq() as any, res as any, next);
    // O status é definido depois, durante o processamento da rota.
    res.statusCode = 500;
    res.finish();

    expect(monitor.recordRequest.mock.calls[0][0].statusCode).toBe(500);
  });

  it('usa req.url quando req.originalUrl não existe', () => {
    const next = jest.fn();
    const req = makeReq({ originalUrl: undefined, url: '/fallback/url' });
    const res = makeRes();

    mw.use(req as any, res as any, next);
    res.finish();

    expect(monitor.recordRequest.mock.calls[0][0].path).toBe('/fallback/url');
  });

  it("cai para '/' quando não há originalUrl nem url", () => {
    const next = jest.fn();
    const req = makeReq({ originalUrl: undefined, url: undefined });
    const res = makeRes();

    mw.use(req as any, res as any, next);
    res.finish();

    expect(monitor.recordRequest.mock.calls[0][0].path).toBe('/');
  });

  it('mede a duração entre o início e o finish (relógio avançado de forma determinística)', () => {
    const next = jest.fn();
    const res = makeRes();

    // Controlamos process.hrtime.bigint para tornar a duração determinística:
    // início = 0ns, finish = 5_000_000ns (= 5ms).
    const spy = jest
      .spyOn(process.hrtime, 'bigint')
      .mockReturnValueOnce(BigInt(0)) // startedAt
      .mockReturnValueOnce(BigInt(5_000_000)); // endedAt (= 5ms)

    try {
      mw.use(makeReq() as any, res as any, next);
      res.finish();
      expect(monitor.recordRequest.mock.calls[0][0].durationMs).toBe(5);
    } finally {
      spy.mockRestore();
    }
  });

  it('inscreve-se no evento "finish" da resposta', () => {
    const next = jest.fn();
    const res = makeRes();
    mw.use(makeReq() as any, res as any, next);
    expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
  });

  it('sempre chama recordRequest (o filtro de rota ignorada é responsabilidade do serviço)', () => {
    // O middleware não conhece rotas ignoradas; ele delega ao serviço.
    // Aqui garantimos que mesmo uma rota "de health" chega ao recordRequest.
    const next = jest.fn();
    const req = makeReq({ originalUrl: '/api/v1/health/performance' });
    const res = makeRes();

    mw.use(req as any, res as any, next);
    res.finish();

    expect(monitor.recordRequest).toHaveBeenCalledTimes(1);
    expect(monitor.recordRequest.mock.calls[0][0].path).toBe('/api/v1/health/performance');
  });

  it('COMPORTAMENTO REAL: o middleware NÃO é fail-open — se o monitor lançar no finish, o erro propaga', () => {
    // Documenta o comportamento atual: recordRequest NÃO está dentro de try/catch.
    // next() já foi chamado antes (a requisição não é afetada), mas o handler de
    // `finish` propaga a exceção. Ver "ressalvas" no relatório.
    const next = jest.fn();
    monitor.recordRequest.mockImplementation(() => {
      throw new Error('monitor caiu');
    });
    const res = makeRes();

    mw.use(makeReq() as any, res as any, next);
    expect(next).toHaveBeenCalledTimes(1); // next não é afetado

    expect(() => res.finish()).toThrow('monitor caiu');
  });
});
