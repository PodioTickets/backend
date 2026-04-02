import type { Ticket, TicketBatch } from '@prisma/client';
import type { UpdateTicketDto } from './dto/create-ticket.dto';

export const TICKET_FIELD_LABELS: Record<string, string> = {
  name: 'nome',
  description: 'descrição',
  categoryId: 'categoria',
  sortOrder: 'ordem de exibição',
  modality: 'modalidade',
  distance: 'distância',
  distanceUnit: 'unidade da distância',
  gender: 'sexo',
  ageLimitMin: 'idade mínima',
  ageLimitMax: 'idade máxima',
  hasKit: 'kit',
  kitId: 'kit',
  isActive: 'situação ativa',
};

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return Boolean(a) === Boolean(b);
  }
  return String(a ?? '') === String(b ?? '');
}

export type TicketBeforeAudit = Ticket & {
  products: { productId: string }[];
  batches: Pick<
    TicketBatch,
    'id' | 'quantity' | 'price' | 'startDate' | 'endDate'
  >[];
};

/**
 * Resume alterações feitas no PATCH do ingresso (campos + lotes + produtos).
 */
export function summarizeTicketUpdateForAudit(
  before: TicketBeforeAudit,
  updateData: Record<string, unknown>,
  updateDto: UpdateTicketDto,
): {
  labels: string[];
  changes: Array<{ field: string; old: unknown; new: unknown }>;
} {
  const labels: string[] = [];
  const changes: Array<{ field: string; old: unknown; new: unknown }> = [];

  for (const [key, v] of Object.entries(updateData)) {
    if (v === undefined) continue;
    if (!(key in before)) continue;
    const oldVal = before[key as keyof Ticket];
    if (valuesEqual(oldVal, v)) continue;
    labels.push(TICKET_FIELD_LABELS[key] ?? key);
    changes.push({
      field: key,
      old: oldVal ?? null,
      new: v,
    });
  }

  if (updateDto.batches !== undefined) {
    labels.push('lotes');
    changes.push({
      field: 'batches',
      old: before.batches.map((b) => ({
        id: b.id,
        quantity: b.quantity,
        price: b.price,
        startDate: b.startDate?.toISOString?.() ?? b.startDate,
        endDate: b.endDate?.toISOString?.() ?? b.endDate,
      })),
      new: updateDto.batches.map((b) => ({
        id: b.id ?? null,
        quantity: b.quantity,
        price: b.price,
        startDate: b.startDate ?? null,
        endDate: b.endDate ?? null,
      })),
    });
  }

  if (updateDto.productIds !== undefined) {
    labels.push('produtos vinculados');
    const oldIds = [...before.products.map((p) => p.productId)].sort();
    const newIds = [...updateDto.productIds].sort();
    changes.push({
      field: 'productIds',
      old: oldIds,
      new: newIds,
    });
  }

  return { labels, changes };
}
