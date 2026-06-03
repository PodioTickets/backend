/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: o "registrador de atividade" — um interceptor OPT-IN. Só anota
 *           atividade nas rotas marcadas com o adesivo `@TrackActivity(...)`.
 *           Rotas sem o adesivo passam direto, sem custo nenhum.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Rota SEM o adesivo → não registra nada, só deixa a resposta passar.
 *    • Rota COM o adesivo (sucesso) → registra UMA vez, com os dados certos
 *      (usuário, IP, sessão, user-agent, caminho, ação, categoria, status).
 *    • IP vem do header `x-forwarded-for` (cliente atrás de proxy/CDN).
 *    • Quando dá erro na request e `trackErrors` é o padrão → registra mesmo
 *      assim, marcando que deu erro, e o erro continua subindo.
 *    • Quando `trackErrors=false` → em erro NÃO registra, mas o erro sobe.
 *    • Se o serviço de gravação explodir, o request principal NÃO quebra
 *      (telemetria é fail-open).
 *
 *  COMO CONFERIMOS:
 *    Espionamos o serviço de atividade (jest.fn) e o Reflector. Sem banco,
 *    sem HTTP real.
 * ============================================================================
 */
import { lastValueFrom, of, throwError } from 'rxjs';
import { UserActivitySource } from '@prisma/client';
import { TrackActivityInterceptor } from '../track-activity.interceptor';
import { TRACK_ACTIVITY_KEY } from '../../decorators/track-activity.decorator';

// ---- Helpers de montagem -------------------------------------------------

const makeRequest = (overrides: any = {}): any => ({
  method: 'POST',
  originalUrl: '/api/v1/checkout/reserve?x=1',
  url: '/checkout/reserve',
  headers: {
    'x-forwarded-for': '203.0.113.7, 10.0.0.1',
    'user-agent': 'jest-agent/1.0',
    'x-session-id': 'sess-abc',
    referer: 'https://podio.tickets/event/foo',
    ...(overrides.headers ?? {}),
  },
  user: { id: 'user-123' },
  body: {},
  ...overrides,
});

const makeContext = (req: any, statusCode = 200): any => {
  const handler = () => undefined;
  return {
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ statusCode }),
    }),
  };
};

describe('TrackActivityInterceptor', () => {
  let interceptor: TrackActivityInterceptor;
  let reflector: { get: jest.Mock };
  let activity: { record: jest.Mock };

  beforeEach(() => {
    reflector = { get: jest.fn() };
    activity = { record: jest.fn() };
    interceptor = new TrackActivityInterceptor(
      reflector as any,
      activity as any,
    );
  });

  it('rota SEM o adesivo @TrackActivity → não registra e deixa a resposta passar', async () => {
    reflector.get.mockReturnValue(undefined); // sem metadata = não opt-in
    const req = makeRequest();

    const out = await lastValueFrom(
      interceptor.intercept(makeContext(req), {
        handle: () => of({ ok: 1 }),
      } as any),
    );

    expect(out).toEqual({ ok: 1 });
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('rota COM o adesivo (sucesso) → registra UMA vez com os dados corretos', async () => {
    reflector.get.mockReturnValue({ category: 'CHECKOUT', action: 'reserve' });
    const req = makeRequest();

    const out = await lastValueFrom(
      interceptor.intercept(makeContext(req, 201), {
        handle: () => of({ ok: 1 }),
      } as any),
    );

    expect(out).toEqual({ ok: 1 });
    expect(activity.record).toHaveBeenCalledTimes(1);

    const payload = activity.record.mock.calls[0][0];
    expect(payload).toMatchObject({
      userId: 'user-123',
      sessionId: 'sess-abc',
      ip: '203.0.113.7', // primeiro hop do x-forwarded-for
      userAgent: 'jest-agent/1.0',
      source: UserActivitySource.BACKEND,
      category: 'CHECKOUT',
      action: 'reserve',
      path: '/api/v1/checkout/reserve?x=1', // originalUrl preservado
      referrer: 'https://podio.tickets/event/foo',
    });
    expect(payload.metadata).toMatchObject({
      method: 'POST',
      statusCode: 201,
    });
    expect(typeof payload.metadata.durationMs).toBe('number');
    expect(payload.metadata.errored).toBeUndefined(); // sucesso não marca errored
  });

  it('usuário anônimo → userId null (jornada costurada por sessionId)', async () => {
    reflector.get.mockReturnValue({ category: 'AUTH', action: 'login' });
    const req = makeRequest({ user: undefined });

    await lastValueFrom(
      interceptor.intercept(makeContext(req), {
        handle: () => of({ ok: 1 }),
      } as any),
    );

    const payload = activity.record.mock.calls[0][0];
    expect(payload.userId).toBeNull();
    expect(payload.sessionId).toBe('sess-abc');
  });

  it('erro na request com trackErrors padrão → registra marcando errored e o erro continua subindo', async () => {
    reflector.get.mockReturnValue({ category: 'AUTH', action: 'login' });
    const req = makeRequest();
    const boom = { status: 403, message: 'forbidden' };

    await expect(
      lastValueFrom(
        interceptor.intercept(makeContext(req), {
          handle: () => throwError(() => boom),
        } as any),
      ),
    ).rejects.toBe(boom);

    expect(activity.record).toHaveBeenCalledTimes(1);
    const payload = activity.record.mock.calls[0][0];
    expect(payload.metadata).toMatchObject({
      statusCode: 403,
      errored: true,
    });
  });

  it('erro com trackErrors=false → NÃO registra, mas o erro continua subindo', async () => {
    reflector.get.mockReturnValue({
      category: 'AUTH',
      action: 'login',
      trackErrors: false,
    });
    const req = makeRequest();
    const boom = { getStatus: () => 401 };

    await expect(
      lastValueFrom(
        interceptor.intercept(makeContext(req), {
          handle: () => throwError(() => boom),
        } as any),
      ),
    ).rejects.toBe(boom);

    expect(activity.record).not.toHaveBeenCalled();
  });

  it('sucesso com trackErrors=false → ainda registra (só erro é ignorado)', async () => {
    reflector.get.mockReturnValue({
      category: 'CHECKOUT',
      action: 'reserve',
      trackErrors: false,
    });
    const req = makeRequest();

    await lastValueFrom(
      interceptor.intercept(makeContext(req), {
        handle: () => of({ ok: 1 }),
      } as any),
    );

    expect(activity.record).toHaveBeenCalledTimes(1);
  });

  it('falha do serviço de atividade NÃO quebra o request (fail-open)', async () => {
    reflector.get.mockReturnValue({ category: 'CHECKOUT', action: 'reserve' });
    activity.record.mockImplementation(() => {
      throw new Error('db down');
    });
    const req = makeRequest();

    const out = await lastValueFrom(
      interceptor.intercept(makeContext(req), {
        handle: () => of({ ok: 1 }),
      } as any),
    );

    expect(out).toEqual({ ok: 1 });
    expect(activity.record).toHaveBeenCalledTimes(1);
  });

  it('sessionId vem do body quando não há header x-session-id', async () => {
    reflector.get.mockReturnValue({ category: 'CHECKOUT', action: 'reserve' });
    const req = makeRequest({
      headers: { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'jest' },
      body: { sessionId: 'sess-from-body' },
    });

    await lastValueFrom(
      interceptor.intercept(makeContext(req), {
        handle: () => of({ ok: 1 }),
      } as any),
    );

    const payload = activity.record.mock.calls[0][0];
    expect(payload.sessionId).toBe('sess-from-body');
    expect(payload.referrer).toBeNull(); // sem referer/referrer → null
  });
});
