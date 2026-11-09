/**
 * Status do card "Lotes próximos de esgotamento" (regra do usuário, 2026-11-09), sobre o % vendido
 * da soma dos lotes: até 30% Normal ("Saudável" no front), até 70% Atenção, acima Crítico. Crítico só
 * no último lote ("3 de 3"); antes dele fica em Atenção. Esgotado (nada restante) é decidido no front.
 */
export function lotDepletionStatus(percentageSold: number, onLastLot: boolean): 'Normal' | 'Atenção' | 'Crítico' {
  if (percentageSold > 70 && onLastLot) return 'Crítico';
  if (percentageSold > 30) return 'Atenção';
  return 'Normal';
}
