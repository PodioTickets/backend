import { Logger } from '@nestjs/common';
import { Request } from 'express';
import { SecurityService } from '../security.service';
import {
  SecurityLoggingInterceptor,
  SecuritySeverity,
} from '../../interceptors/security-logging.interceptor';

/*
 * ============================================================================
 * ROTEIRO (em português leigo) — o que este teste verifica
 * ============================================================================
 *
 * O SecurityService é uma "caixa de ferramentas" de segurança. Ele faz duas
 * coisas bem distintas:
 *
 * A) ENCAMINHAR LOGS DE SEGURANÇA
 *    Os métodos logInvalidInput / logReplayAttack / logTransactionValidationFailed
 *    / logEvent NÃO têm lógica própria de verdade: eles apenas repassam a chamada
 *    para um "logger de segurança" interno (SecurityLoggingInterceptor) que o
 *    serviço cria sozinho no construtor. Para esses, o que importa testar é se o
 *    repasse acontece com os argumentos certos. Então "grampeamos" (spy) os
 *    métodos do logger e conferimos a delegação. No caso do logEvent, ele ainda
 *    traduz a severidade em texto ('low'/'medium'/'high'/'critical') para o enum
 *    interno — conferimos essa tradução.
 *
 * B) UTILITÁRIOS DETERMINÍSTICOS (a parte com lógica de verdade)
 *
 *    1) sanitizeForLogging(data)
 *       - Esconde campos sensíveis (privateKey, secret, password, token, apiKey,
 *         csrfSecret) trocando o valor por '[REDACTED]'.
 *       - Corta strings muito longas (> 100 chars) deixando os 100 primeiros +
 *         '...[TRUNCATED]'.
 *       - Se receber algo que não é objeto (null, string, número), devolve igual.
 *
 *    2) checkRateLimit(identifier, windowMs, maxRequests)
 *       - Conta quantas chamadas chegaram dentro de uma "janela de tempo".
 *       - Devolve true enquanto está dentro do limite; false quando estoura.
 *       - Pedidos velhos (fora da janela) "expiram" e param de contar.
 *       - Como ele usa o relógio (Date.now), congelamos o tempo nos testes.
 *
 *    3) generateSecureHash(data)
 *       - Gera um hash SHA-256 (string hex de 64 chars). Mesma entrada => mesmo
 *         hash (determinístico); entradas diferentes => hashes diferentes.
 *
 *    4) validateDataFormat(data, schema)
 *       - Validador de "esquema" bem simples: checa obrigatoriedade (required),
 *         tipo (string/number/boolean) e tamanho (minLength/maxLength).
 *       - Devolve true/false e NUNCA explode.
 *
 * O serviço não recebe provider injetado (construtor vazio), então instanciamos
 * direto. Silenciamos o Logger para não poluir a saída e usamos fake timers para
 * a parte sensível a tempo.
 * ============================================================================
 */

describe('SecurityService', () => {
  let service: SecurityService;

  beforeAll(() => {
    // Silencia o Logger do Nest para não poluir a saída dos testes.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    service = new SecurityService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Limpa o store global de rate-limit entre testes para isolar casos.
    delete (global as any).rateLimitStore;
  });

  // --------------------------------------------------------------------------
  // A) ENCAMINHAMENTO DE LOGS (delegação ao SecurityLoggingInterceptor)
  // --------------------------------------------------------------------------
  describe('encaminhamento de logs (delegação ao logger interno)', () => {
    const fakeRequest = { method: 'POST' } as unknown as Request;

    it('logInvalidInput repassa field/value/request ao logger interno', () => {
      const spy = jest
        .spyOn(SecurityLoggingInterceptor.prototype, 'logInvalidInput')
        .mockImplementation(() => undefined);

      service.logInvalidInput('email', 'lixo', fakeRequest);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('email', 'lixo', fakeRequest);
    });

    it('logReplayAttack repassa wallet/timestamp/request ao logger interno', () => {
      const spy = jest
        .spyOn(SecurityLoggingInterceptor.prototype, 'logReplayAttack')
        .mockImplementation(() => undefined);

      service.logReplayAttack('0xabc', 123456, fakeRequest);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('0xabc', 123456, fakeRequest);
    });

    it('logTransactionValidationFailed repassa txHash/error/request ao logger interno', () => {
      const spy = jest
        .spyOn(
          SecurityLoggingInterceptor.prototype,
          'logTransactionValidationFailed',
        )
        .mockImplementation(() => undefined);

      service.logTransactionValidationFailed('0xhash', 'falhou', fakeRequest);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('0xhash', 'falhou', fakeRequest);
    });

    it('logEvent traduz cada severidade textual para o enum interno correto', () => {
      const spy = jest
        .spyOn(SecurityLoggingInterceptor.prototype, 'logEvent')
        .mockImplementation(() => undefined);

      const casos: Array<['low' | 'medium' | 'high' | 'critical', SecuritySeverity]> = [
        ['low', SecuritySeverity.LOW],
        ['medium', SecuritySeverity.MEDIUM],
        ['high', SecuritySeverity.HIGH],
        ['critical', SecuritySeverity.CRITICAL],
      ];

      casos.forEach(([texto, enumEsperado], i) => {
        service.logEvent('tipo', `msg-${i}`, { i }, texto, fakeRequest);
        expect(spy).toHaveBeenNthCalledWith(
          i + 1,
          'tipo',
          `msg-${i}`,
          { i },
          enumEsperado,
          fakeRequest,
        );
      });

      expect(spy).toHaveBeenCalledTimes(4);
    });

    it('logEvent funciona sem request (request opcional)', () => {
      const spy = jest
        .spyOn(SecurityLoggingInterceptor.prototype, 'logEvent')
        .mockImplementation(() => undefined);

      service.logEvent('tipo', 'msg', undefined, 'low');

      expect(spy).toHaveBeenCalledWith(
        'tipo',
        'msg',
        undefined,
        SecuritySeverity.LOW,
        undefined,
      );
    });
  });

  // --------------------------------------------------------------------------
  // B.1) sanitizeForLogging
  // --------------------------------------------------------------------------
  describe('sanitizeForLogging', () => {
    it('devolve o valor intacto quando não é objeto (null/undefined/string/número)', () => {
      expect(service.sanitizeForLogging(null)).toBeNull();
      expect(service.sanitizeForLogging(undefined)).toBeUndefined();
      expect(service.sanitizeForLogging('texto')).toBe('texto');
      expect(service.sanitizeForLogging(42)).toBe(42);
    });

    it('substitui todos os campos sensíveis por [REDACTED]', () => {
      const out = service.sanitizeForLogging({
        privateKey: 'pk',
        secret: 's',
        password: 'p',
        token: 't',
        apiKey: 'a',
        csrfSecret: 'c',
        publico: 'visivel',
      });

      expect(out.privateKey).toBe('[REDACTED]');
      expect(out.secret).toBe('[REDACTED]');
      expect(out.password).toBe('[REDACTED]');
      expect(out.token).toBe('[REDACTED]');
      expect(out.apiKey).toBe('[REDACTED]');
      expect(out.csrfSecret).toBe('[REDACTED]');
      // Campo não sensível permanece igual.
      expect(out.publico).toBe('visivel');
    });

    it('não cria chaves de campos sensíveis ausentes e ignora valores falsy', () => {
      // password = '' é falsy => o if (sanitized[field]) não redige (comportamento real).
      const out = service.sanitizeForLogging({ password: '', x: 1 });
      expect(out.password).toBe('');
      expect(out.x).toBe(1);
      // privateKey nunca existiu, não deve ser inventada.
      expect('privateKey' in out).toBe(false);
    });

    it('trunca strings com mais de 100 caracteres', () => {
      const longa = 'a'.repeat(150);
      const out = service.sanitizeForLogging({ campo: longa });
      expect(out.campo).toBe('a'.repeat(100) + '...[TRUNCATED]');
      expect(out.campo).toHaveLength(100 + '...[TRUNCATED]'.length);
    });

    it('não trunca strings com exatamente 100 caracteres (limite inclusivo)', () => {
      const exata = 'b'.repeat(100);
      const out = service.sanitizeForLogging({ campo: exata });
      expect(out.campo).toBe(exata);
    });

    it('não altera o objeto original (faz cópia rasa)', () => {
      const original = { password: 'segredo', publico: 'ok' };
      const out = service.sanitizeForLogging(original);
      expect(original.password).toBe('segredo');
      expect(out).not.toBe(original);
    });

    it('um campo sensível longo é redigido (redação tem prioridade sobre truncamento)', () => {
      const out = service.sanitizeForLogging({ token: 'x'.repeat(200) });
      // Redação roda antes; '[REDACTED]' tem 10 chars (< 100), então não é truncado.
      expect(out.token).toBe('[REDACTED]');
    });
  });

  // --------------------------------------------------------------------------
  // B.2) checkRateLimit (sensível a tempo => fake timers)
  // --------------------------------------------------------------------------
  describe('checkRateLimit', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-06-03T00:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('permite chamadas até atingir o limite e bloqueia a que excede', () => {
      // maxRequests = 3: as 3 primeiras passam, a 4ª é bloqueada.
      expect(service.checkRateLimit('user', 60000, 3)).toBe(true);
      expect(service.checkRateLimit('user', 60000, 3)).toBe(true);
      expect(service.checkRateLimit('user', 60000, 3)).toBe(true);
      expect(service.checkRateLimit('user', 60000, 3)).toBe(false);
    });

    it('usa os defaults (janela 60s, máximo 10 requisições)', () => {
      for (let i = 0; i < 10; i++) {
        expect(service.checkRateLimit('default')).toBe(true);
      }
      expect(service.checkRateLimit('default')).toBe(false);
    });

    it('libera novamente após as requisições saírem da janela de tempo', () => {
      expect(service.checkRateLimit('janela', 1000, 1)).toBe(true);
      // Ainda dentro da janela => bloqueia.
      expect(service.checkRateLimit('janela', 1000, 1)).toBe(false);

      // Avança o relógio para além da janela (a request antiga expira).
      jest.advanceTimersByTime(1500);
      expect(service.checkRateLimit('janela', 1000, 1)).toBe(true);
    });

    it('contabiliza identificadores diferentes de forma independente', () => {
      expect(service.checkRateLimit('a', 60000, 1)).toBe(true);
      expect(service.checkRateLimit('a', 60000, 1)).toBe(false);
      // 'b' tem seu próprio contador.
      expect(service.checkRateLimit('b', 60000, 1)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // B.3) generateSecureHash (cripto => testar propriedades)
  // --------------------------------------------------------------------------
  describe('generateSecureHash', () => {
    it('produz string hexadecimal de 64 caracteres (SHA-256)', () => {
      const hash = service.generateSecureHash('qualquer-coisa');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('é determinístico: mesma entrada => mesmo hash', () => {
      expect(service.generateSecureHash('repetivel')).toBe(
        service.generateSecureHash('repetivel'),
      );
    });

    it('entradas diferentes produzem hashes diferentes', () => {
      expect(service.generateSecureHash('a')).not.toBe(
        service.generateSecureHash('b'),
      );
    });

    it('aceita string vazia e produz um hash válido (vetor conhecido do SHA-256)', () => {
      // SHA-256 da string vazia é um valor canônico bem conhecido.
      expect(service.generateSecureHash('')).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });
  });

  // --------------------------------------------------------------------------
  // B.4) validateDataFormat
  // --------------------------------------------------------------------------
  describe('validateDataFormat', () => {
    it('devolve false quando data não é objeto (null/undefined/primitivo)', () => {
      expect(service.validateDataFormat(null, {})).toBe(false);
      expect(service.validateDataFormat(undefined, {})).toBe(false);
      expect(service.validateDataFormat('x', {})).toBe(false);
      expect(service.validateDataFormat(5, {})).toBe(false);
    });

    it('schema vazio => qualquer objeto é válido', () => {
      expect(service.validateDataFormat({ a: 1 }, {})).toBe(true);
      expect(service.validateDataFormat({}, {})).toBe(true);
    });

    it('campo required ausente (undefined/null) => false', () => {
      const schema = { nome: { required: true } };
      expect(service.validateDataFormat({}, schema)).toBe(false);
      expect(service.validateDataFormat({ nome: null }, schema)).toBe(false);
      expect(service.validateDataFormat({ nome: 'ok' }, schema)).toBe(true);
    });

    it('valida tipos string/number/boolean', () => {
      expect(
        service.validateDataFormat({ s: 'txt' }, { s: { type: 'string' } }),
      ).toBe(true);
      expect(
        service.validateDataFormat({ s: 1 }, { s: { type: 'string' } }),
      ).toBe(false);

      expect(
        service.validateDataFormat({ n: 10 }, { n: { type: 'number' } }),
      ).toBe(true);
      expect(
        service.validateDataFormat({ n: '10' }, { n: { type: 'number' } }),
      ).toBe(false);

      expect(
        service.validateDataFormat({ b: true }, { b: { type: 'boolean' } }),
      ).toBe(true);
      expect(
        service.validateDataFormat({ b: 'true' }, { b: { type: 'boolean' } }),
      ).toBe(false);
    });

    it('checagem de tipo é ignorada quando o campo é undefined (e não required)', () => {
      // value === undefined => o bloco de type não roda; sem required => passa.
      expect(
        service.validateDataFormat({}, { opcional: { type: 'string' } }),
      ).toBe(true);
    });

    it('respeita minLength e maxLength em strings', () => {
      const schema = { nome: { type: 'string', minLength: 2, maxLength: 5 } };
      expect(service.validateDataFormat({ nome: 'a' }, schema)).toBe(false); // curta
      expect(service.validateDataFormat({ nome: 'ab' }, schema)).toBe(true); // limite inferior
      expect(service.validateDataFormat({ nome: 'abcde' }, schema)).toBe(true); // limite superior
      expect(service.validateDataFormat({ nome: 'abcdef' }, schema)).toBe(false); // longa
    });

    it('minLength/maxLength são ignorados para valores não-string', () => {
      // value não é string => o typeof value === 'string' falha => regra não aplica.
      expect(
        service.validateDataFormat({ n: 1 }, { n: { minLength: 5 } }),
      ).toBe(true);
    });

    it('valida múltiplos campos em conjunto (todos precisam passar)', () => {
      const schema = {
        nome: { required: true, type: 'string', minLength: 2 },
        idade: { type: 'number' },
      };
      expect(
        service.validateDataFormat({ nome: 'Ana', idade: 30 }, schema),
      ).toBe(true);
      // idade com tipo errado derruba o conjunto.
      expect(
        service.validateDataFormat({ nome: 'Ana', idade: '30' }, schema),
      ).toBe(false);
    });
  });
});
