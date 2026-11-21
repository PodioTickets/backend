/**
 * Status do card "Lotes próximos de esgotamento" (regra do usuário, 2026-11-09; faixas de 2026-11-10),
 * sobre o % vendido da soma dos lotes: até 50% Normal ("Saudável" no front), até 80% Atenção, acima
 * Crítico. Crítico só no último lote ("3 de 3"); antes dele fica em Atenção. Esgotado (nada restante)
 * é decidido no front.
 */
export function lotDepletionStatus(percentageSold: number, onLastLot: boolean): 'Normal' | 'Atenção' | 'Crítico' {
  if (percentageSold > 80 && onLastLot) return 'Crítico';
  if (percentageSold > 50) return 'Atenção';
  return 'Normal';
}
