import { BadRequestException } from '@nestjs/common';

/**
 * Quantidade mínima/máxima de um ingresso por pedido (null = sem limite). Mínimo maior
 * que o máximo tornaria o ingresso impossível de comprar — recusado no create/update.
 */
export function assertPurchaseQuantityRange(
  min: number | null | undefined,
  max: number | null | undefined,
): void {
  if (min != null && max != null && min > max) {
    throw new BadRequestException('A quantidade mínima não pode ser maior que a quantidade máxima.');
  }
}

/**
 * Motivo pelo qual `units` unidades do ingresso violam o mínimo/máximo por pedido (ou null).
 * Mínimo só vale se o ingresso está no pedido (0 = não levou).
 */
export function purchaseQuantityError(
  ticket: { name: string; minPurchaseQuantity?: number | null; maxPurchaseQuantity?: number | null },
  units: number,
): string | null {
  const min = ticket.minPurchaseQuantity ?? 0;
  const max = ticket.maxPurchaseQuantity ?? 0;
  if (min > 1 && units > 0 && units < min) {
    return `O ingresso "${ticket.name}" exige a compra de no mínimo ${min} unidades.`;
  }
  if (max > 0 && units > max) {
    return `O ingresso "${ticket.name}" permite no máximo ${max} ${max === 1 ? 'unidade' : 'unidades'} por pedido.`;
  }
  return null;
}
