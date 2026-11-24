import {
  normalizeVariationIds,
  resolveVariationSelection,
} from '../../common/utils/product-variation.util';

/**
 * Regras puras da troca de ingresso pelo admin (anula a inscrição antiga e cria uma nova).
 * Espelham as do checkout (InformationStep.getParticipantValidationErrors no front) para
 * a troca não aceitar um participante que a compra normal recusaria.
 */

/** "YYYY-MM-DD" (UTC) → {y,m,d}. DateTime do Prisma chega em UTC; o front compara o mesmo prefixo ISO. */
function ymd(date: Date): { y: number; m: number; d: number } {
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

/** Idade NO DIA DO EVENTO (mesma regra do checkout); sem data do evento, usa hoje. */
export function ageOnEventDay(birthDate: Date, eventDate: Date | null, now = new Date()): number {
  const ref = ymd(eventDate ?? now);
  const birth = ymd(birthDate);
  let age = ref.y - birth.y;
  if (ref.m < birth.m || (ref.m === birth.m && ref.d < birth.d)) age--;
  return age;
}

export interface SwapParticipant {
  dateOfBirth: Date | null;
  gender: string | null;
}

export interface SwapTicketRules {
  ageLimitMin: number | null;
  ageLimitMax: number | null;
  gender: string | null;
}

/** Motivo pelo qual o participante NÃO pode ir para o ingresso (ou null se pode). */
export function swapEligibilityError(
  participant: SwapParticipant,
  ticket: SwapTicketRules,
  eventDate: Date | null,
): string | null {
  if (ticket.ageLimitMin || ticket.ageLimitMax) {
    if (!participant.dateOfBirth) {
      return 'O participante não tem data de nascimento e o ingresso tem limite de idade';
    }
    const age = ageOnEventDay(participant.dateOfBirth, eventDate);
    if (ticket.ageLimitMin && age < ticket.ageLimitMin) {
      return `Idade mínima para este ingresso é ${ticket.ageLimitMin} anos no dia do evento`;
    }
    if (ticket.ageLimitMax && age > ticket.ageLimitMax) {
      return `Idade máxima para este ingresso é ${ticket.ageLimitMax} anos no dia do evento`;
    }
  }

  const tg = (ticket.gender ?? '').trim().toLowerCase();
  if (tg && tg !== 'all') {
    const pg = (participant.gender ?? '').trim().toLowerCase();
    if (tg.startsWith('m') && !pg.startsWith('m')) {
      return 'Este ingresso é exclusivo para participantes do sexo masculino';
    }
    if (tg.startsWith('f') && !pg.startsWith('f')) {
      return 'Este ingresso é exclusivo para participantes do sexo feminino';
    }
  }
  return null;
}

export interface SwapAllowedProduct {
  id: string;
  name: string;
  isRequired: boolean;
  variations: Array<{ id: string; name?: string; groupId?: string | null }>;
  /** Variações (grupos) do kit — 1 opção por grupo. */
  variationGroups?: Array<{ id: string; name: string; sortOrder?: number }>;
}

export interface SwapProductSelection {
  productId: string;
  /** Kit com várias variações: 1 opção por variação. */
  variationIds?: string[] | null;
  /** Legado = variationIds[0]. */
  variationId?: string | null;
}

/**
 * Valida a escolha de produtos para o ingresso novo: só produtos vinculados ao ingresso,
 * sem repetição, variação obrigatória (e válida) quando o produto tem variações, e todo
 * produto OBRIGATÓRIO com variação presente.
 */
export function swapProductsError(
  allowed: SwapAllowedProduct[],
  selection: SwapProductSelection[],
): string | null {
  const byId = new Map(allowed.map((p) => [p.id, p]));
  const seen = new Set<string>();
  for (const item of selection) {
    const product = byId.get(item.productId);
    if (!product) return 'Produto não disponível para o ingresso escolhido';
    if (seen.has(item.productId)) return `Produto "${product.name}" repetido`;
    seen.add(item.productId);
    const ids = normalizeVariationIds(item);
    if (product.variations.length > 0) {
      if (ids.length === 0) return `Escolha a opção de "${product.name}"`;
      if (ids.some((id) => !product.variations.some((v) => v.id === id))) {
        return `Opção inválida para "${product.name}"`;
      }
      // 1 opção por variação (e todas as variações respondidas), "Sem interesse" sozinho.
      const selectionError = resolveVariationSelection(
        { ...product, variations: product.variations.map((v) => ({ name: '', ...v })) },
        ids,
      ).error;
      if (selectionError) return selectionError;
    } else if (ids.length > 0) {
      return `Opção inválida para "${product.name}"`;
    }
  }
  // Obrigatório só é exigível quando tem variação — produto sem variação nunca vira item
  // do pedido, nem na compra (checkoutProductStep no front).
  const missing = allowed.find((p) => p.isRequired && p.variations.length > 0 && !seen.has(p.id));
  if (missing) return `Escolha a opção de "${missing.name}"`;
  return null;
}
