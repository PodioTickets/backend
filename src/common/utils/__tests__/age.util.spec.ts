/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: cálculo da idade de uma pessoa numa determinada data.
 *
 *  EM RESUMO:
 *    O sistema precisa saber a idade do participante NA DATA DO EVENTO (e não a
 *    idade de hoje). Isso é usado, por exemplo, no cupom "por idade": se alguém
 *    completa 60 anos pouco antes do evento, já tem direito ao desconto de 60+.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Se o aniversário já passou no ano, conta a idade cheia.
 *    • Se o aniversário ainda não chegou, conta um ano a menos.
 *    • No dia exato do aniversário, já conta como "fez aniversário".
 *    • A conta é feita na data do evento (faz 60 antes do evento → vale 60; depois → ainda 59).
 *    • Se a data de nascimento vier errada/vazia, o sistema avisa (devolve -1) em vez de errar a conta.
 *
 *  COMO CONFERIMOS:
 *    Passamos várias datas de nascimento e datas de evento e conferimos o número de
 *    anos. É uma conta pura: não envolve banco de dados nem internet — roda 100% real.
 * ============================================================================
 */
import { computeAgeAt } from '../age.util';

// Helper: data UTC determinística (evita fuso do ambiente).
const d = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe('computeAgeAt', () => {
  it('retorna idade cheia quando o aniversário já passou no ano de referência', () => {
    // nasceu 1990-01-10; referência 2026-06-02 → já fez aniversário em 2026
    expect(computeAgeAt(d('1990-01-10'), d('2026-06-02'))).toBe(36);
  });

  it('subtrai 1 quando o aniversário ainda não chegou (mês posterior)', () => {
    // nasceu 1990-12-10; referência 2026-06-02 → ainda não fez 36
    expect(computeAgeAt(d('1990-12-10'), d('2026-06-02'))).toBe(35);
  });

  it('subtrai 1 no mesmo mês quando o dia ainda não chegou', () => {
    expect(computeAgeAt(d('1990-06-20'), d('2026-06-02'))).toBe(35);
  });

  it('conta a idade quando o aniversário é exatamente a data de referência', () => {
    expect(computeAgeAt(d('1990-06-02'), d('2026-06-02'))).toBe(36);
  });

  it('mede a idade na DATA DO EVENTO (cupom AGE): completa 60 antes do evento → 60', () => {
    // faz 60 em 2026-07-15; evento em 2026-08-01 → elegível (60), mesmo que hoje tenha 59
    const eventDate = d('2026-08-01');
    expect(computeAgeAt(d('1966-07-15'), eventDate)).toBe(60);
  });

  it('NÃO conta quando o evento é ANTES do aniversário (ainda 59 no evento)', () => {
    const eventDate = d('2026-07-01');
    expect(computeAgeAt(d('1966-07-15'), eventDate)).toBe(59);
  });

  it('aceita string ISO equivalente a Date', () => {
    expect(computeAgeAt('1990-01-10', d('2026-06-02'))).toBe(36);
  });

  it('recém-nascido na data de referência → 0 anos', () => {
    expect(computeAgeAt(d('2026-06-02'), d('2026-06-02'))).toBe(0);
  });

  it('data de nascimento inválida → -1', () => {
    expect(computeAgeAt('não-é-data', d('2026-06-02'))).toBe(-1);
    expect(computeAgeAt(new Date('inválida'), d('2026-06-02'))).toBe(-1);
  });
});
