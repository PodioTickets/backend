/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: o login "opcional" — usado em telas que funcionam logado OU deslogado
 *           (ex.: ver um cupom). Se houver login válido, identifica o usuário; se não,
 *           deixa passar como visitante (anônimo) em vez de bloquear.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Com usuário autenticado → devolve o usuário.
 *    • Sem usuário (visitante) → devolve "ninguém" (null), sem dar erro de não-autorizado.
 *
 *  COMO CONFERIMOS:
 *    Chamamos o tratamento de resultado do guard com e sem usuário. Conta pura — sem banco.
 * ============================================================================
 */
import { OptionalJwtAuthGuard } from '../optional-jwt-auth.guard';

describe('OptionalJwtAuthGuard.handleRequest', () => {
  const guard = new OptionalJwtAuthGuard();

  it('devolve o usuário quando há login válido', () => {
    const user = { id: 'u1' };
    expect(guard.handleRequest(null, user)).toBe(user);
  });

  it('devolve null (visitante) quando não há usuário — sem bloquear', () => {
    expect(guard.handleRequest(null, undefined)).toBeNull();
    expect(guard.handleRequest(new Error('sem token'), null)).toBeNull();
  });
});
