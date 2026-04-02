import type { Prisma } from '@prisma/client';

/**
 * Remove um productId de kitSelectionDisplay (JSON no Event) após exclusão do produto.
 * Não altera relações no banco — só o mapa salvo no evento.
 */
export function stripDeletedProductFromKitSelectionDisplay(
  raw: Prisma.JsonValue,
  productId: string,
): { next: Prisma.JsonValue; changed: boolean } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { next: raw, changed: false };
  }

  const o = raw as Record<string, unknown>;
  let changed = false;

  const ticketSrc = o.primaryKitProductByTicketId;
  const pm: Record<string, string> =
    ticketSrc &&
    typeof ticketSrc === 'object' &&
    !Array.isArray(ticketSrc)
      ? { ...(ticketSrc as Record<string, string>) }
      : {};

  for (const [k, v] of Object.entries(pm)) {
    if (v === productId) {
      delete pm[k];
      changed = true;
    }
  }

  const catSrc = o.primaryKitProductByCategoryId;
  const cm: Record<string, string> =
    catSrc && typeof catSrc === 'object' && !Array.isArray(catSrc)
      ? { ...(catSrc as Record<string, string>) }
      : {};

  for (const [k, v] of Object.entries(cm)) {
    if (v === productId) {
      delete cm[k];
      changed = true;
    }
  }

  if (!changed) {
    return { next: raw, changed: false };
  }

  const next = {
    ...o,
    primaryKitProductByTicketId: pm,
    primaryKitProductByCategoryId: cm,
  } as Prisma.JsonValue;

  return { next, changed: true };
}
