import { GoogleAuthGuard } from '../guards/google-auth.guard';

/**
 * O guard injeta o `state` (redirect_to saneado + assinado) na URL de consent do Google
 * via getAuthenticateOptions. Aqui validamos só essa responsabilidade (a parte passport
 * de redirecionar é coberta pelo framework).
 */
describe('GoogleAuthGuard.getAuthenticateOptions', () => {
  const mkContext = (query: any) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ query }) }),
    }) as any;

  it('assina o redirect_to da query e devolve { state }', () => {
    const oauthState = { sign: jest.fn().mockReturnValue('SIGNED_STATE') };
    const guard = new GoogleAuthGuard(oauthState as any);

    const opts = guard.getAuthenticateOptions(mkContext({ redirect_to: '/checkout/ingressos?eventId=XYZ' }));

    expect(oauthState.sign).toHaveBeenCalledWith('/checkout/ingressos?eventId=XYZ');
    expect(opts).toEqual({ state: 'SIGNED_STATE' });
  });

  it('sem redirect_to → ainda assina (state com destino vazio)', () => {
    const oauthState = { sign: jest.fn().mockReturnValue('SIGNED_EMPTY') };
    const guard = new GoogleAuthGuard(oauthState as any);

    const opts = guard.getAuthenticateOptions(mkContext({}));

    expect(oauthState.sign).toHaveBeenCalledWith(undefined);
    expect(opts).toEqual({ state: 'SIGNED_EMPTY' });
  });
});
