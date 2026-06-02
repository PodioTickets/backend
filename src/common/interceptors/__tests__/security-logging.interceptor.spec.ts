/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: o "registrador de segurança" — anota eventos (chamadas, erros, tentativas
 *           suspeitas) com um nível de gravidade, para acompanhamento.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • A resposta passa intacta (o registrador não altera o conteúdo).
 *    • Cada gravidade vai para o canal certo: baixa = info, média = aviso, alta = erro.
 *
 *  COMO CONFERIMOS:
 *    Espionamos o registrador e conferimos onde cada evento é anotado. Sem banco.
 * ============================================================================
 */
import { lastValueFrom, of } from 'rxjs';
import {
  SecurityLoggingInterceptor,
  SecurityEventType,
  SecuritySeverity,
} from '../security-logging.interceptor';

const ctxFor = (body: any = {}): any => ({
  switchToHttp: () => ({ getRequest: () => ({ body, method: 'POST', headers: {}, url: '/x' }) }),
});

describe('SecurityLoggingInterceptor', () => {
  let interceptor: SecurityLoggingInterceptor;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    interceptor = new SecurityLoggingInterceptor();
    logger = (interceptor as any).logger;
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  it('deixa a resposta passar intacta', async () => {
    const out = await lastValueFrom(
      interceptor.intercept(ctxFor(), { handle: () => of({ ok: 1 }) } as any),
    );
    expect(out).toEqual({ ok: 1 });
  });

  it('gravidade baixa vai para info (log)', () => {
    interceptor.logEvent(SecurityEventType.CONTRACT_INTERACTION, 'msg', {}, SecuritySeverity.LOW);
    expect(logger.log).toHaveBeenCalled();
  });

  it('gravidade média vai para aviso (warn)', () => {
    interceptor.logEvent(SecurityEventType.INVALID_INPUT, 'msg', {}, SecuritySeverity.MEDIUM);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('gravidade alta vai para erro (error)', () => {
    interceptor.logEvent(SecurityEventType.REPLAY_ATTACK, 'msg', {}, SecuritySeverity.HIGH);
    expect(logger.error).toHaveBeenCalled();
  });
});
