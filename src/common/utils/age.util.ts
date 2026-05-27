/**
 * Utilitário de idade — fonte única de verdade para a matemática de idade.
 *
 * Usado tanto na aplicação de cupons AGE no checkout (`orders.service`) quanto
 * no endpoint de elegibilidade (`coupons.service`). Compartilhar a função
 * garante que os dois nunca divirjam: o endpoint nunca promete um desconto que
 * o checkout negaria, nem o contrário.
 */

/**
 * Idade em anos numa data de referência (aniversário-aware).
 *
 * Em cupons AGE a idade considera a data do EVENTO, não a data atual. Ex.:
 * cupom min=60 + evento daqui 2 meses + participante que completa 60 anos antes
 * do evento → cupom é aplicado.
 *
 * O cálculo por (ano/mês/dia) — em vez de dias/365.25 — evita o erro de ±1
 * perto do aniversário (a aproximação por 365.25 antecipa a virada em até
 * ~6 horas/ano).
 *
 * @returns idade em anos, ou -1 se a data de nascimento for inválida.
 */
export function computeAgeAt(
  birthDate: Date | string,
  referenceDate: Date,
): number {
  const birth = birthDate instanceof Date ? birthDate : new Date(birthDate);
  if (isNaN(birth.getTime())) return -1;
  let age = referenceDate.getFullYear() - birth.getFullYear();
  const monthDiff = referenceDate.getMonth() - birth.getMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && referenceDate.getDate() < birth.getDate())
  ) {
    age--;
  }
  return age;
}
