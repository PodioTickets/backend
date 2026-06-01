import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { OAuthStateService } from '../oauth-state.service';

describe('OAuthStateService (state do OAuth Google)', () => {
  const SECRET = 'test-secret';
  let jwt: JwtService;
  let service: OAuthStateService;

  beforeEach(() => {
    jwt = new JwtService({ secret: SECRET });
    const config = { get: (k: string) => (k === 'JWT_SECRET' ? SECRET : undefined) } as unknown as ConfigService;
    service = new OAuthStateService(jwt, config);
  });

  it('round-trip: assina e recupera o destino saneado', () => {
    const state = service.sign('/checkout/ingressos?eventId=XYZ');
    expect(service.verify(state)).toEqual({ redirectTo: '/checkout/ingressos?eventId=XYZ' });
  });

  it('destino inválido na assinatura → não persiste (verify devolve null)', () => {
    const state = service.sign('http://evil.com');
    expect(service.verify(state)).toEqual({ redirectTo: null });
  });

  it('sem destino → verify devolve null', () => {
    const state = service.sign(undefined);
    expect(service.verify(state)).toEqual({ redirectTo: null });
  });

  it('state ausente → null (não lança)', () => {
    expect(service.verify(undefined)).toEqual({ redirectTo: null });
    expect(service.verify('')).toEqual({ redirectTo: null });
  });

  it('state adulterado / assinado com outro segredo → null (anti-tampering)', () => {
    const forged = new JwtService({ secret: 'outro-segredo' }).sign({ rt: '/admin' });
    expect(service.verify(forged)).toEqual({ redirectTo: null });
  });

  it('state expirado → null', () => {
    const expired = jwt.sign({ rt: '/checkout' }, { secret: SECRET, expiresIn: -1 });
    expect(service.verify(expired)).toEqual({ redirectTo: null });
  });

  it('verify saneia de novo (defesa em profundidade contra payload forjado válido)', () => {
    // payload assinado com o segredo correto mas com rt malicioso (ex.: token vazado/forjado
    // por quem tem o segredo) → ainda assim o sanitize barra o open-redirect.
    const malicious = jwt.sign({ rt: '//evil.com' }, { secret: SECRET });
    expect(service.verify(malicious)).toEqual({ redirectTo: null });
  });

  it('cada state tem nonce próprio (não é determinístico)', () => {
    expect(service.sign('/x')).not.toBe(service.sign('/x'));
  });
});
