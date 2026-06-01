import { AuthController } from '../auth.controller';

/**
 * Callback do Google mediado pelo backend: valida o `state`, extrai o redirect_to saneado
 * e redireciona para {FRONTEND}/auth/callback repassando code + redirect_to (ou error).
 */
describe('AuthController.googleCallback', () => {
  const FRONTEND = 'https://app.podiotickets.com';

  const mkController = (verifyReturn: { redirectTo: string | null }) => {
    const oauthState = { verify: jest.fn().mockReturnValue(verifyReturn) };
    const configService = { get: jest.fn().mockReturnValue(FRONTEND) };
    const controller = new AuthController({} as any, oauthState as any, configService as any);
    return { controller, oauthState };
  };

  const captureRedirect = () => {
    const res: any = { redirect: jest.fn() };
    const url = () => new URL(res.redirect.mock.calls[0][0]);
    return { res, url };
  };

  it('code válido + state com redirect_to → redireciona com code e redirect_to saneado', async () => {
    const { controller, oauthState } = mkController({ redirectTo: '/checkout/ingressos?eventId=XYZ' });
    const { res, url } = captureRedirect();

    await controller.googleCallback('AUTH_CODE', 'STATE', undefined, res);

    expect(oauthState.verify).toHaveBeenCalledWith('STATE');
    const u = url();
    expect(u.origin + u.pathname).toBe(`${FRONTEND}/auth/callback`);
    expect(u.searchParams.get('code')).toBe('AUTH_CODE');
    expect(u.searchParams.get('redirect_to')).toBe('/checkout/ingressos?eventId=XYZ');
    expect(u.searchParams.get('error')).toBeNull();
  });

  it('state inválido/expirado (redirectTo null) → redireciona com code mas SEM redirect_to', async () => {
    const { controller } = mkController({ redirectTo: null });
    const { res, url } = captureRedirect();

    await controller.googleCallback('AUTH_CODE', 'BAD_STATE', undefined, res);

    const u = url();
    expect(u.searchParams.get('code')).toBe('AUTH_CODE');
    expect(u.searchParams.get('redirect_to')).toBeNull();
  });

  it('erro do Google (access_denied) → repassa ?error e NÃO manda code', async () => {
    const { controller } = mkController({ redirectTo: '/checkout' });
    const { res, url } = captureRedirect();

    await controller.googleCallback(undefined, 'STATE', 'access_denied', res);

    const u = url();
    expect(u.searchParams.get('error')).toBe('access_denied');
    expect(u.searchParams.get('code')).toBeNull();
    // redirect_to ainda é repassado pra o front rotear depois do erro
    expect(u.searchParams.get('redirect_to')).toBe('/checkout');
  });

  it('sem code e sem error → error genérico google_oauth_failed', async () => {
    const { controller } = mkController({ redirectTo: null });
    const { res, url } = captureRedirect();

    await controller.googleCallback(undefined, undefined, undefined, res);

    expect(url().searchParams.get('error')).toBe('google_oauth_failed');
  });

  it('redirect_to malicioso que escapou do state → sanitize barra (sem redirect_to)', async () => {
    // mesmo que o verify devolva algo perigoso, o controller saneia de novo (defesa em profundidade)
    const { controller } = mkController({ redirectTo: '//evil.com' as any });
    const { res, url } = captureRedirect();

    await controller.googleCallback('AUTH_CODE', 'STATE', undefined, res);

    expect(url().searchParams.get('redirect_to')).toBeNull();
  });
});
