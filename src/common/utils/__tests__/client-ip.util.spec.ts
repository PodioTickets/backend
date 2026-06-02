/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: descobrir o endereço de internet (IP) de quem fez o pedido.
 *
 *  EM RESUMO:
 *    O IP é usado em registros de segurança e auditoria. Como o site fica atrás de um
 *    intermediário (Cloudflare), o IP real do visitante vem num cabeçalho especial
 *    (x-forwarded-for). Esta peça sabe pegar o IP certo em todos os formatos.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Pega o primeiro IP do cabeçalho x-forwarded-for (o mais próximo do visitante).
 *    • Funciona quando o cabeçalho vem como texto único, lista separada por vírgula ou lista.
 *    • Se não houver o cabeçalho, usa o IP que o próprio servidor detectou.
 *    • Se não der para descobrir nada, devolve vazio (não quebra os registros).
 *
 *  COMO CONFERIMOS:
 *    Montamos pedidos de mentira com cada formato de cabeçalho e conferimos o IP retornado.
 *    É uma conta pura — não envolve banco nem internet.
 * ============================================================================
 */
import { getClientIp } from '../client-ip.util';

const reqWith = (headers: any, ip?: string): any => ({ headers, ip });

describe('getClientIp', () => {
  it('pega o primeiro IP do x-forwarded-for (texto com vários)', () => {
    expect(getClientIp(reqWith({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
  });

  it('aceita o x-forwarded-for como lista (array)', () => {
    expect(getClientIp(reqWith({ 'x-forwarded-for': ['198.51.100.2, 10.0.0.1'] }))).toBe('198.51.100.2');
  });

  it('remove espaços ao redor do IP', () => {
    expect(getClientIp(reqWith({ 'x-forwarded-for': '  192.0.2.5  ' }))).toBe('192.0.2.5');
  });

  it('sem o cabeçalho, usa o IP detectado pelo servidor', () => {
    expect(getClientIp(reqWith({}, '192.0.2.10'))).toBe('192.0.2.10');
  });

  it('sem cabeçalho e sem IP, devolve vazio', () => {
    expect(getClientIp(reqWith({}))).toBe('');
  });

  it('pedido inexistente devolve vazio', () => {
    expect(getClientIp(undefined)).toBe('');
  });
});
