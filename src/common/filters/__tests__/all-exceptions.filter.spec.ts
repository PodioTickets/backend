/**
 * ============================================================================
 * ROTEIRO (em português leigo) — O que este arquivo testa
 * ============================================================================
 *
 * O AllExceptionsFilter é a "última linha de defesa" dos erros da API: tudo
 * que estoura sem tratamento passa por ele antes de virar resposta HTTP.
 *
 * Já tivemos um vazamento real em produção (2026-06-05): criar organização com
 * documento duplicado estourava P2002 do Prisma e o front recebia um 500 com a
 * MENSAGEM CRUA do Prisma (caminho de arquivo do servidor, trecho de código,
 * stack trace). Este arquivo garante que isso nunca volte:
 *
 *   A. Erros CONHECIDOS do Prisma viram respostas amigáveis:
 *      - P2002 (valor duplicado)  → 409 + código DUPLICATE_VALUE + campo PT-BR
 *      - P2025 (não encontrado)   → 404 + RECORD_NOT_FOUND
 *      - P2003 (vínculo/FK)       → 409 + RELATED_RECORDS_EXIST
 *      - P-código desconhecido    → 500 genérico (sem detalhe interno)
 *   B. Erro genérico (Error comum) NÃO vaza a mensagem crua em produção —
 *      vira "Erro interno do servidor". Em development a mensagem aparece
 *      (pra facilitar o debug local).
 *   C. HttpException normal (fluxo de negócio) continua passando intacta.
 *
 * COMO testamos: sem servidor — instanciamos o filtro com dublês de
 * HttpAdapterHost/ArgumentsHost e inspecionamos o body passado pro reply().
 * ============================================================================
 */

import { HttpStatus, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from '../all-exceptions.filter';

describe('AllExceptionsFilter — mapeamento de erros pra respostas seguras', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  /** Monta filtro + dublês e devolve uma função que dispara o catch e retorna o body. */
  function run(exception: unknown): { body: any; status: number } {
    const reply = jest.fn();
    const adapterHost = {
      httpAdapter: {
        getRequestUrl: () => '/api/v1/teste',
        reply,
      },
    } as any;

    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ url: '/api/v1/teste', method: 'POST', body: {}, query: {}, params: {} }),
        getResponse: () => ({ headersSent: false, finished: false }),
      }),
    } as any;

    const filter = new AllExceptionsFilter(adapterHost);
    filter.catch(exception, host);

    expect(reply).toHaveBeenCalledTimes(1);
    const [, body, status] = reply.mock.calls[0];
    return { body, status };
  }

  /** Cria um PrismaClientKnownRequestError realista (mesma classe do runtime). */
  function prismaError(code: string, meta?: Record<string, unknown>) {
    return new Prisma.PrismaClientKnownRequestError(
      `\nInvalid tx.organization.create() invocation in\n/usr/src/app/dist/app/organizations/organizations.service.js:434:56\nUnique constraint failed on the fields: (document)`,
      { code, clientVersion: '6.18.0', meta },
    );
  }

  describe('A. Erros conhecidos do Prisma', () => {
    it('P2002 (unique) vira 409 DUPLICATE_VALUE com rótulo PT-BR do campo', () => {
      const { body, status } = run(prismaError('P2002', { target: ['document'] }));

      expect(status).toBe(HttpStatus.CONFLICT);
      expect(body.code).toBe('DUPLICATE_VALUE');
      expect(body.message).toContain('documento (CPF/CNPJ)');
      // O ponto central: NADA da mensagem crua do Prisma no body.
      expect(JSON.stringify(body)).not.toContain('/usr/src/app');
      expect(JSON.stringify(body)).not.toContain('Invalid tx.');
    });

    it('P2002 com campo fora do mapa usa o nome cru do campo (ainda sem vazar internals)', () => {
      const { body, status } = run(prismaError('P2002', { target: ['externalRef'] }));

      expect(status).toBe(HttpStatus.CONFLICT);
      expect(body.message).toContain('externalRef');
      expect(JSON.stringify(body)).not.toContain('/usr/src/app');
    });

    it('P2025 (registro não existe) vira 404 RECORD_NOT_FOUND', () => {
      const { body, status } = run(prismaError('P2025'));

      expect(status).toBe(HttpStatus.NOT_FOUND);
      expect(body.code).toBe('RECORD_NOT_FOUND');
    });

    it('P2003 (FK) vira 409 RELATED_RECORDS_EXIST', () => {
      const { body, status } = run(prismaError('P2003'));

      expect(status).toBe(HttpStatus.CONFLICT);
      expect(body.code).toBe('RELATED_RECORDS_EXIST');
    });

    it('código Prisma desconhecido vira 500 genérico (sem mensagem crua)', () => {
      const { body, status } = run(prismaError('P2010'));

      expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(body.message).toBe('Erro interno do servidor');
      expect(JSON.stringify(body)).not.toContain('/usr/src/app');
    });
  });

  describe('B. Error genérico não vaza em produção', () => {
    it('em produção: mensagem vira "Erro interno do servidor" (sem path/SQL/stack)', () => {
      process.env.NODE_ENV = 'production';
      const { body, status } = run(new Error('connect ECONNREFUSED 10.0.0.5:5432 at /usr/src/app/dist/x.js'));

      expect(status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(body.message).toBe('Erro interno do servidor');
      expect(body.stack).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    });

    it('em development: mensagem original aparece (DX) e stack vem junto', () => {
      process.env.NODE_ENV = 'development';
      const { body } = run(new Error('detalhe útil pra debug local'));

      expect(body.message).toBe('detalhe útil pra debug local');
      expect(body.stack).toBeDefined();
    });
  });

  describe('C. HttpException de negócio passa intacta', () => {
    it('ConflictException mantém status 409 e mensagem do service', () => {
      const { body, status } = run(
        new ConflictException('Já existe uma organização cadastrada com este documento (CPF/CNPJ): Acme'),
      );

      expect(status).toBe(HttpStatus.CONFLICT);
      expect(body.message).toContain('Acme');
    });
  });
});
