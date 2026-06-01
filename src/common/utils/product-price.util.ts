/**
 * Resolve o preço unitário efetivo COBRADO por um produto considerando a variação
 * selecionada. Fonte ÚNICA de verdade — usada pelo checkout (orders.service) e pelo
 * finalize compartilhado (OrderFinalizationService), garantindo que o preço gravado
 * no pedido e o gravado nas inscrições (RegistrationProduct/snapshot) nunca divirjam.
 *
 * Regras:
 * - Produto INCLUSO no ingresso (`isIncludedInTicket`) → 0, SEMPRE. O custo já está
 *   embutido no preço do ingresso; o comprador nunca paga a mais por ele —
 *   independente de ser obrigatório ou opcional, e qualquer que seja a variação
 *   escolhida (a escolha de variação serve só pra capturar tamanho/cor, não pra cobrar).
 * - Sem variação → `basePrice`.
 * - Variação "Sem interesse" → 0 (opt-out de produto opcional; convenção do projeto).
 * - Variação com `price > 0` → usa o price da variação (sobrescreve basePrice).
 * - Variação com `price === 0` (e nome ≠ "Sem interesse") → fallback para basePrice.
 *   Cobre o caso de organizer cadastrar variações P/M/G sem preencher price,
 *   esperando que o basePrice prevaleça.
 */
export function resolveProductUnitPrice(
  product: any,
  variation: any | null | undefined,
): number {
  // Incluso no ingresso nunca é cobrado à parte (precede qualquer regra de variação).
  if (product?.isIncludedInTicket === true) return 0;
  const basePrice = product?.basePrice ?? 0;
  if (!variation) return basePrice;
  if (variation.name === 'Sem interesse') return 0;
  return variation.price > 0 ? variation.price : basePrice;
}
