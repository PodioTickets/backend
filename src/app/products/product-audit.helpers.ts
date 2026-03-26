import type { Product, ProductVariation } from '@prisma/client';
import type { UpdateProductDto } from './dto/create-product.dto';

const PRODUCT_FIELD_LABELS: Record<string, string> = {
  name: 'nome',
  image: 'imagem',
  isIncludedInTicket: 'incluso no ingresso',
  basePrice: 'preço base',
  isRequired: 'obrigatório',
  variationType: 'tipo de variação',
};

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return Boolean(a) === Boolean(b);
  }
  return String(a ?? '') === String(b ?? '');
}

export type ProductBeforeAudit = Product & {
  variations: Pick<ProductVariation, 'id' | 'name' | 'price' | 'stock'>[];
};

export type ProductVariationAuditSnapshot = {
  name: string;
  price: number;
  stock: number;
};

/**
 * Diff de campos escalares em `updateData` (sem `variations`) + troca de variações quando enviadas.
 * `newVariations` = lista já normalizada (ex.: após ensureDefaultNoInterestVariation), só para o metadata.
 */
export function summarizeProductUpdateForAudit(
  before: ProductBeforeAudit,
  updateDataScalars: Record<string, unknown>,
  updateDto: UpdateProductDto,
  newVariations?: ProductVariationAuditSnapshot[] | null,
): {
  labels: string[];
  changes: Array<{ field: string; old: unknown; new: unknown }>;
} {
  const labels: string[] = [];
  const changes: Array<{ field: string; old: unknown; new: unknown }> = [];

  for (const [key, v] of Object.entries(updateDataScalars)) {
    if (v === undefined) continue;
    if (!(key in before)) continue;
    const oldVal = before[key as keyof Product];
    if (valuesEqual(oldVal, v)) continue;
    labels.push(PRODUCT_FIELD_LABELS[key] ?? key);
    changes.push({
      field: key,
      old: oldVal ?? null,
      new: v,
    });
  }

  if (updateDto.variations !== undefined && newVariations != null) {
    labels.push('variações');
    changes.push({
      field: 'variations',
      old: before.variations.map((v) => ({
        name: v.name,
        price: v.price,
        stock: v.stock,
      })),
      new: newVariations,
    });
  }

  return { labels, changes };
}
