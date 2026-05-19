import type { Prisma } from '@prisma/client';

/**
 * Lê o objeto bruto do JSON e devolve uma cópia rasa dos dois sub-mapas
 * (`primaryKitProductByTicketId` e `primaryKitProductByCategoryId`), preservando
 * os demais campos. Centraliza a checagem defensiva de "é objeto plano".
 */
function readKitSelectionMaps(raw: Prisma.JsonValue): {
  parent: Record<string, unknown>;
  ticketMap: Record<string, string>;
  categoryMap: Record<string, string>;
} | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const parent = raw as Record<string, unknown>;

  const ticketSrc = parent.primaryKitProductByTicketId;
  const ticketMap: Record<string, string> =
    ticketSrc && typeof ticketSrc === 'object' && !Array.isArray(ticketSrc)
      ? { ...(ticketSrc as Record<string, string>) }
      : {};

  const catSrc = parent.primaryKitProductByCategoryId;
  const categoryMap: Record<string, string> =
    catSrc && typeof catSrc === 'object' && !Array.isArray(catSrc)
      ? { ...(catSrc as Record<string, string>) }
      : {};

  return { parent, ticketMap, categoryMap };
}

/**
 * Remove um productId de kitSelectionDisplay (JSON no Event) após exclusão do produto.
 * Varre os dois sub-mapas porque `productId` aparece como *valor* (imagem do kit
 * vinculada por ticket/categoria). Não altera relações no banco — só o JSON.
 */
export function stripDeletedProductFromKitSelectionDisplay(
  raw: Prisma.JsonValue,
  productId: string,
): { next: Prisma.JsonValue; changed: boolean } {
  const maps = readKitSelectionMaps(raw);
  if (!maps) return { next: raw, changed: false };

  const { parent, ticketMap, categoryMap } = maps;
  let changed = false;

  for (const [k, v] of Object.entries(ticketMap)) {
    if (v === productId) {
      delete ticketMap[k];
      changed = true;
    }
  }

  for (const [k, v] of Object.entries(categoryMap)) {
    if (v === productId) {
      delete categoryMap[k];
      changed = true;
    }
  }

  if (!changed) return { next: raw, changed: false };

  const next = {
    ...parent,
    primaryKitProductByTicketId: ticketMap,
    primaryKitProductByCategoryId: categoryMap,
  } as Prisma.JsonValue;

  return { next, changed: true };
}

/**
 * Remove um ticketId de kitSelectionDisplay (JSON no Event) após exclusão do ticket.
 * `ticketId` é *chave* de `primaryKitProductByTicketId` — só esse mapa é afetado.
 * Não altera relações no banco — só o JSON salvo no evento.
 */
export function stripDeletedTicketFromKitSelectionDisplay(
  raw: Prisma.JsonValue,
  ticketId: string,
): { next: Prisma.JsonValue; changed: boolean } {
  const maps = readKitSelectionMaps(raw);
  if (!maps) return { next: raw, changed: false };

  const { parent, ticketMap, categoryMap } = maps;
  if (!(ticketId in ticketMap)) return { next: raw, changed: false };

  delete ticketMap[ticketId];

  const next = {
    ...parent,
    primaryKitProductByTicketId: ticketMap,
    primaryKitProductByCategoryId: categoryMap,
  } as Prisma.JsonValue;

  return { next, changed: true };
}

/**
 * Remove um categoryId de kitSelectionDisplay (JSON no Event) após exclusão da categoria.
 * `categoryId` é *chave* de `primaryKitProductByCategoryId` — só esse mapa é afetado.
 * A chave literal `'uncategorized'` (UNCATEGORIZED_CATEGORY_KEY) é preservada por design:
 * não corresponde a nenhum UUID de categoria real.
 * Não altera relações no banco — só o JSON salvo no evento.
 */
export function stripDeletedCategoryFromKitSelectionDisplay(
  raw: Prisma.JsonValue,
  categoryId: string,
): { next: Prisma.JsonValue; changed: boolean } {
  const maps = readKitSelectionMaps(raw);
  if (!maps) return { next: raw, changed: false };

  const { parent, ticketMap, categoryMap } = maps;
  if (!(categoryId in categoryMap)) return { next: raw, changed: false };

  delete categoryMap[categoryId];

  const next = {
    ...parent,
    primaryKitProductByTicketId: ticketMap,
    primaryKitProductByCategoryId: categoryMap,
  } as Prisma.JsonValue;

  return { next, changed: true };
}
