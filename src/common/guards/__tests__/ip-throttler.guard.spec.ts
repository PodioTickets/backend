/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: o "guarda de rate-limit por IP" — limita quantas requisições cada
 *           cliente pode fazer num intervalo de tempo. Para isso, ele precisa
 *           saber QUEM é o cliente, e essa identidade é o IP.
 *
 *  O PROBLEMA QUE ISSO RESOLVE:
 *    O guarda padrão do NestJS (ThrottlerGuard) identifica o cliente pelo
 *    `req.ip`. Atrás de um proxy/load balancer (produção), o `req.ip` é o IP do
 *    PRÓPRIO proxy — igual para todo mundo. Resultado: TODOS os usuários caem no
 *    mesmo "balde" e o limite vira um teto GLOBAL minúsculo.
 *
 *    Esta subclasse (IpThrottlerGuard) sobrescreve o `getTracker` para usar o IP
 *    REAL do cliente, lido do header `x-forwarded-for` (que o proxy preenche).
 *
 *  O QUE PASSA A VALER (cada item é um teste aqui embaixo):
 *    • Com `x-forwarded-for`, usa o PRIMEIRO IP da lista (o mais próximo do cliente).
 *    • Sem header nenhum, cai pro `req.ip` (fallback).
 *    • `x-forwarded-for` em formato CSV ("clienteA, proxy1, proxy2") → pega o 1º.
 *    • `x-forwarded-for` vazio ("") → ignora o header e cai pro `req.ip`.
 *
 *  DETALHE TÉCNICO: o método `getTracker` é `protected`, então o acessamos via
 *  cast `(guard as any)` só nos testes. O construtor do ThrottlerGuard exige 3
 *  dependências (options, storage, reflector), mas como só exercitamos o
 *  `getTracker` (que não usa nenhuma delas), passamos stubs vazios.
 * ============================================================================
 */
import { IpThrottlerGuard } from '../ip-throttler.guard';

describe('IpThrottlerGuard (identificador de cliente por IP real)', () => {
  let guard: IpThrottlerGuard;

  // Helper: chama o getTracker protegido. Retorna Promise<string>.
  const getTracker = (req: any): Promise<string> =>
    (guard as any).getTracker(req);

  beforeEach(() => {
    // Stubs vazios: options/storage/reflector não são tocados pelo getTracker.
    guard = new IpThrottlerGuard({} as any, {} as any, {} as any);
  });

  it('com x-forwarded-for: usa o IP do cliente (não o req.ip do proxy)', async () => {
    const req = { ip: '10.0.0.1', headers: { 'x-forwarded-for': '200.1.1.1' } };
    await expect(getTracker(req)).resolves.toBe('200.1.1.1');
  });

  it('sem header nenhum: cai pro req.ip (fallback)', async () => {
    const req = { ip: '203.0.113.9', headers: {} };
    await expect(getTracker(req)).resolves.toBe('203.0.113.9');
  });

  it('x-forwarded-for como CSV: pega o PRIMEIRO IP da lista (o mais próximo do cliente)', async () => {
    // Formato típico atrás de múltiplos proxies: "cliente, proxy1, proxy2".
    const req = {
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': '200.1.1.1, 70.0.0.2, 70.0.0.3' },
    };
    await expect(getTracker(req)).resolves.toBe('200.1.1.1');
  });

  it('x-forwarded-for vazio: ignora o header e cai pro req.ip', async () => {
    const req = { ip: '203.0.113.9', headers: { 'x-forwarded-for': '' } };
    await expect(getTracker(req)).resolves.toBe('203.0.113.9');
  });
});
