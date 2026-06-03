/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: o "porteiro" Turnstile — antes de deixar um pedido entrar, ele confere
 *           com a Cloudflare se quem está fazendo o pedido é gente de verdade (e não
 *           um robô). O navegador manda um "ticket" (token) e o porteiro pergunta para
 *           a Cloudflare: "esse ticket é válido?". Só libera se a Cloudflare disser sim.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Sem a chave secreta configurada e fora de produção → libera (modo desenvolvimento).
 *    • Sem a chave secreta configurada e EM produção → estoura erro (não pode rodar assim).
 *    • Com chave, mas sem o ticket no pedido → bloqueado.
 *    • Com chave e ticket, e a Cloudflare confirma (success=true) → liberado.
 *    • Com chave e ticket, mas a Cloudflare recusa (success=false) → bloqueado.
 *    • O endereço de quem pediu (IP) é tirado do cabeçalho "x-forwarded-for"
 *      (o primeiro da lista, sem espaços) e enviado para a Cloudflare; se não houver,
 *      usa o IP direto do pedido.
 *    • Se a internet/Cloudflare falhar: em produção bloqueia (porta fechada por segurança);
 *      fora de produção libera (para não travar o dev).
 *
 *  COMO CONFERIMOS:
 *    Trocamos a "ligação" para a Cloudflare por uma dublê (mock do HttpService) que
 *    responde o que a gente mandar. Montamos pedidos de mentira (ExecutionContext falso).
 *    Conta pura — sem banco nem internet de verdade.
 * ============================================================================
 */
import { BadRequestException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { TurnstileGuard } from '../turnstile.guard';

// ConfigService de mentira: devolve a chave secreta que pedirmos no teste.
const mkConfig = (secret?: string): any => ({
  get: jest.fn().mockReturnValue(secret),
});

// HttpService de mentira: o .post() devolve um Observable com a resposta da "Cloudflare".
const mkHttp = (postImpl: jest.Mock): any => ({ post: postImpl });

// ExecutionContext de mentira: simula o request HTTP (body, headers, ip).
const ctxFor = (req: any): any => ({
  switchToHttp: () => ({ getRequest: () => req }),
});

describe('TurnstileGuard', () => {
  const ENV_ORIGINAL = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = ENV_ORIGINAL;
    jest.clearAllMocks();
  });

  describe('quando NÃO há chave secreta configurada (bypass)', () => {
    it('fora de produção → libera (true) sem chamar a Cloudflare', async () => {
      process.env.NODE_ENV = 'test';
      const post = jest.fn();
      const guard = new TurnstileGuard(mkConfig(undefined), mkHttp(post));

      const liberou = await guard.canActivate(ctxFor({}));

      expect(liberou).toBe(true);
      expect(post).not.toHaveBeenCalled();
    });

    it('em produção → estoura erro (configuração obrigatória)', async () => {
      process.env.NODE_ENV = 'production';
      const post = jest.fn();
      const guard = new TurnstileGuard(mkConfig(undefined), mkHttp(post));

      await expect(guard.canActivate(ctxFor({}))).rejects.toThrow(
        'CLOUDFLARE_TURNSTILE_SECRET_KEY is required in production',
      );
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('com chave secreta configurada', () => {
    const SECRET = 'segredo-turnstile';

    it('sem o ticket (turnstileToken) no corpo do pedido → bloqueia', async () => {
      const post = jest.fn();
      const guard = new TurnstileGuard(mkConfig(SECRET), mkHttp(post));

      const ctx = ctxFor({ body: {}, headers: {}, ip: '1.2.3.4' });

      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(BadRequestException);
      expect(post).not.toHaveBeenCalled();
    });

    it('ticket válido e Cloudflare confirma (success=true) → libera', async () => {
      const post = jest.fn().mockReturnValue(of({ data: { success: true } }));
      const guard = new TurnstileGuard(mkConfig(SECRET), mkHttp(post));

      const ctx = ctxFor({
        body: { turnstileToken: 'TICKET-OK' },
        headers: {},
        ip: '9.9.9.9',
      });

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(post).toHaveBeenCalledTimes(1);
    });

    it('Cloudflare recusa (success=false) → bloqueia', async () => {
      const post = jest
        .fn()
        .mockReturnValue(of({ data: { success: false, 'error-codes': ['invalid-input-response'] } }));
      const guard = new TurnstileGuard(mkConfig(SECRET), mkHttp(post));

      const ctx = ctxFor({
        body: { turnstileToken: 'TICKET-RUIM' },
        headers: {},
        ip: '9.9.9.9',
      });

      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('envia para a Cloudflare o segredo, o ticket e a URL correta', async () => {
      const post = jest.fn().mockReturnValue(of({ data: { success: true } }));
      const guard = new TurnstileGuard(mkConfig(SECRET), mkHttp(post));

      const ctx = ctxFor({
        body: { turnstileToken: 'TICKET-OK' },
        headers: {},
        ip: '5.5.5.5',
      });

      await guard.canActivate(ctx);

      expect(post).toHaveBeenCalledWith(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        expect.objectContaining({ secret: SECRET, response: 'TICKET-OK' }),
        expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
      );
    });

    describe('extração do IP (remoteip) enviado à Cloudflare', () => {
      it('usa o PRIMEIRO IP do x-forwarded-for, sem espaços', async () => {
        const post = jest.fn().mockReturnValue(of({ data: { success: true } }));
        const guard = new TurnstileGuard(mkConfig(SECRET), mkHttp(post));

        const ctx = ctxFor({
          body: { turnstileToken: 'TICKET-OK' },
          headers: { 'x-forwarded-for': '  203.0.113.10 , 70.41.3.18 , 150.172.238.178' },
          ip: '127.0.0.1',
        });

        await guard.canActivate(ctx);

        expect(post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ remoteip: '203.0.113.10' }),
          expect.anything(),
        );
      });

      it('sem x-forwarded-for → usa o request.ip', async () => {
        const post = jest.fn().mockReturnValue(of({ data: { success: true } }));
        const guard = new TurnstileGuard(mkConfig(SECRET), mkHttp(post));

        const ctx = ctxFor({
          body: { turnstileToken: 'TICKET-OK' },
          headers: {},
          ip: '198.51.100.7',
        });

        await guard.canActivate(ctx);

        expect(post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ remoteip: '198.51.100.7' }),
          expect.anything(),
        );
      });
    });

    describe('falha de rede/API da Cloudflare', () => {
      it('em produção → bloqueia (porta fechada por segurança)', async () => {
        process.env.NODE_ENV = 'production';
        const post = jest.fn().mockReturnValue(throwError(() => new Error('timeout de rede')));
        const guard = new TurnstileGuard(mkConfig(SECRET), mkHttp(post));

        const ctx = ctxFor({
          body: { turnstileToken: 'TICKET-OK' },
          headers: {},
          ip: '9.9.9.9',
        });

        await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(BadRequestException);
      });

      it('fora de produção → libera (não trava o desenvolvimento)', async () => {
        process.env.NODE_ENV = 'test';
        const post = jest.fn().mockReturnValue(throwError(() => new Error('timeout de rede')));
        const guard = new TurnstileGuard(mkConfig(SECRET), mkHttp(post));

        const ctx = ctxFor({
          body: { turnstileToken: 'TICKET-OK' },
          headers: {},
          ip: '9.9.9.9',
        });

        await expect(guard.canActivate(ctx)).resolves.toBe(true);
      });
    });
  });
});
