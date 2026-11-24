import { BadRequestException } from '@nestjs/common';

/**
 * Kit com várias variações (grupos) — FONTE ÚNICA das regras de seleção e do rótulo exibido.
 *
 * Modelo: Product → ProductVariationGroup[] (a pergunta, ex.: "Tamanho da camisa") →
 * ProductVariation[] (as opções, `groupId`). "Sem interesse" é uma ProductVariation do
 * produto SEM grupo (`groupId = null`): escolher ela recusa o kit inteiro.
 *
 * Usado por checkout (orders), finalize/estorno, troca de ingresso, alteração de variação,
 * leituras de produto/inscrição, PDF, e-mails, exportações e dashboard.
 */

/** Nome da opção opt-out (duplicado de products/product.constants p/ não importar app em common). */
export const NO_INTEREST_VARIATION_NAME = 'Sem interesse';

export function isNoInterestVariation(v: { name?: string | null } | null | undefined): boolean {
  return (v?.name ?? '').trim().toLowerCase() === NO_INTEREST_VARIATION_NAME.toLowerCase();
}

/**
 * Normaliza a escolha recebida (pedido, troca, alteração) ou gravada (pendingProducts,
 * RegistrationProduct): `variationIds` vence; senão `variationId` legado; sem duplicatas.
 */
export function normalizeVariationIds(item: {
  variationIds?: (string | null | undefined)[] | null;
  variationId?: string | null;
} | null | undefined): string[] {
  const raw =
    Array.isArray(item?.variationIds) && item!.variationIds!.length > 0
      ? item!.variationIds!
      : item?.variationId
        ? [item.variationId]
        : [];
  return [...new Set(raw.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/** Opção mínima usada nas regras abaixo. */
export interface VariationOptionLike {
  id: string;
  name: string;
  groupId?: string | null;
  price?: number;
  stock?: number;
}

export interface VariationGroupLike {
  id: string;
  name: string;
  sortOrder?: number;
}

/**
 * Valida a escolha de opções de um produto e devolve as opções NA ORDEM DOS GRUPOS.
 * Regras (contrato 20/11):
 * - toda opção pertence ao produto;
 * - "Sem interesse" vai sozinha (recusa o kit inteiro);
 * - no máximo 1 opção por grupo;
 * - produto com grupos (e escolha ≠ "Sem interesse") → exatamente 1 por grupo, desde que
 *   alguma opção tenha sido enviada. Lista vazia continua aceita (comportamento atual: o
 *   front decide se o kit é obrigatório; aqui só barramos escolhas inconsistentes).
 * Opções antigas sem grupo (produto ainda não migrado) contam como um grupo único implícito.
 * @returns `{ error }` com mensagem pt-BR quando inválido (o caller escolhe a exceção).
 */
export function resolveVariationSelection(
  product: {
    name?: string;
    variations?: VariationOptionLike[] | null;
    variationGroups?: VariationGroupLike[] | null;
  },
  ids: string[],
): { variations: VariationOptionLike[]; error?: undefined } | { variations?: undefined; error: string } {
  const label = product?.name ? ` para "${product.name}"` : '';
  if (ids.length === 0) return { variations: [] };
  const all = product?.variations ?? [];
  const chosen: VariationOptionLike[] = [];
  for (const id of ids) {
    const v = all.find((x) => x.id === id);
    if (!v) {
      return { error: `Variação selecionada não encontrada${label}. Selecione uma opção válida.` };
    }
    chosen.push(v);
  }
  if (chosen.some(isNoInterestVariation)) {
    if (chosen.length > 1) {
      return { error: `"${NO_INTEREST_VARIATION_NAME}" não pode ser escolhido junto com outras opções${label}.` };
    }
    return { variations: chosen };
  }
  const groupKey = (v: VariationOptionLike) => v.groupId ?? '__sem_grupo__';
  const seen = new Set<string>();
  for (const v of chosen) {
    const k = groupKey(v);
    if (seen.has(k)) {
      return { error: `Escolha apenas uma opção por variação${label}.` };
    }
    seen.add(k);
  }
  const groups = [...(product?.variationGroups ?? [])].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
  );
  if (groups.length > 0) {
    // Opção sem grupo num kit com grupos = opção removida pelo organizador (mantida só
    // pelo histórico de vendas) → não pode mais ser escolhida.
    const detached = chosen.find((v) => !v.groupId);
    if (detached) {
      return { error: `A opção "${detached.name}" não está mais disponível${label}.` };
    }
    const missing = groups.find((g) => !seen.has(g.id));
    if (missing) {
      return { error: `Escolha uma opção de "${missing.name}"${label}.` };
    }
    const order = new Map(groups.map((g, i) => [g.id, i]));
    chosen.sort((a, b) => (order.get(a.groupId ?? '') ?? 999) - (order.get(b.groupId ?? '') ?? 999));
  }
  return { variations: chosen };
}

/** Uma escolha exibível (resposta da inscrição / PDF / exportações). */
export interface VariationChoice {
  id: string;
  name: string;
  groupId: string | null;
  groupName: string | null;
}

/**
 * Monta a lista exibível de opções escolhidas (ordem dos grupos), a partir dos ids e das
 * opções/grupos conhecidos. Ids desconhecidos (opção apagada) caem no fallback (snapshot).
 */
export function buildVariationChoices(
  ids: string[],
  variations: { id: string; name: string; groupId?: string | null }[] | null | undefined,
  groups: { id: string; name: string; sortOrder?: number }[] | null | undefined,
  fallback?: { id?: string | null; name?: string | null } | null,
): VariationChoice[] {
  const vMap = new Map((variations ?? []).map((v) => [v.id, v]));
  const gList = groups ?? [];
  const gMap = new Map(gList.map((g) => [g.id, g]));
  const out: VariationChoice[] = [];
  for (const id of ids) {
    const v = vMap.get(id);
    if (v) {
      const g = v.groupId ? gMap.get(v.groupId) : undefined;
      out.push({ id: v.id, name: v.name, groupId: v.groupId ?? null, groupName: g?.name ?? null });
    } else if (fallback?.id === id && fallback.name) {
      out.push({ id, name: fallback.name, groupId: null, groupName: null });
    }
  }
  if (out.length === 0 && fallback?.name) {
    out.push({ id: fallback.id ?? '', name: fallback.name, groupId: null, groupName: null });
  }
  const order = new Map(
    [...gList].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((g, i) => [g.id, i]),
  );
  return out
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) =>
        (order.get(a.c.groupId ?? '') ?? 999) - (order.get(b.c.groupId ?? '') ?? 999) || a.i - b.i,
    )
    .map(({ c }) => c);
}

/**
 * Rótulo único da escolha. 1 opção: "M" (igual ao legado). Várias:
 * "Tamanho da camisa: M · Tamanho do short: G" (sem nome de grupo → só a opção).
 */
export function buildVariationLabel(
  choices: { name: string; groupName?: string | null }[] | null | undefined,
): string {
  const list = (choices ?? []).filter((c) => !!c?.name);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0].name;
  return list.map((c) => (c.groupName ? `${c.groupName}: ${c.name}` : c.name)).join(' · ');
}

/**
 * Atalho p/ RegistrationProduct carregado com `product: { variations, variationGroups }` e
 * `variation`: devolve `{ variations, variationLabel }` do contrato. Usa o snapshot
 * (`productSnapshot.selectedVariations`) quando as opções vivas não existem mais.
 */
export function describeRegistrationProductVariations(rp: any): {
  variations: VariationChoice[];
  variationLabel: string;
} {
  const ids = normalizeVariationIds(rp);
  const snap = (rp?.productSnapshot as any) ?? {};
  const snapChoices: VariationChoice[] | null = Array.isArray(snap.selectedVariations)
    ? snap.selectedVariations
    : null;
  // `rp.variation` vem PRIMEIRO: costuma ser carregada enxuta ({id,name}, sem groupId) e,
  // no Map por id, a última vence — senão apagava o grupo da 1ª opção (export saía
  // "Short: G · M" em vez de "Camisa: M · Short: G").
  const liveVariations = [
    ...(rp?.variation ? [rp.variation] : []),
    ...(rp?.product?.variations ?? []),
  ];
  let variations = buildVariationChoices(
    ids,
    liveVariations,
    rp?.product?.variationGroups ?? null,
    rp?.variation ?? snap.selectedVariation ?? null,
  );
  // Opções apagadas depois da compra: o snapshot preserva o que foi escolhido.
  if (snapChoices && snapChoices.length > variations.length) variations = snapChoices;
  return { variations, variationLabel: buildVariationLabel(variations) };
}

/**
 * Preço unitário cobrado p/ uma seleção com várias opções. Fluxo novo: opção sem preço →
 * `basePrice`. Opções antigas com preço próprio continuam valendo (1ª com price > 0).
 * Recebe `resolveProductUnitPrice` p/ manter a regra única em product-price.util.
 */
export function pickPricingVariation<T extends { name?: string; price?: number }>(
  variations: T[],
): T | null {
  if (variations.length === 0) return null;
  return variations.find((v) => isNoInterestVariation(v)) ?? variations.find((v) => (v.price ?? 0) > 0) ?? variations[0];
}

/**
 * Ids das opções cujo estoque o item de pedido SEGUROU. Pedidos novos gravam
 * `heldVariationIds`; pedidos antigos só têm `stockHeld` + `variationId`.
 */
export function heldVariationIdsOf(item: any): string[] {
  if (Array.isArray(item?.heldVariationIds)) return item.heldVariationIds.filter(Boolean);
  return item?.stockHeld && item?.variationId ? [item.variationId] : [];
}

/**
 * Agrupa as variações de um produto (já com `groupId`) nos grupos do contrato:
 * `variationGroups[{ id, name, sortOrder, variations[] }]`, ambos ordenados por sortOrder.
 * Quando o produto já veio com `variationGroups` incluídos (Prisma), só ordena.
 */
export function buildProductVariationGroups(product: any): any[] {
  const groups: any[] = [...(product?.variationGroups ?? [])].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
  );
  const flat: any[] = product?.variations ?? [];
  return groups.map((g) => {
    const opts = (Array.isArray(g.variations) && g.variations.length > 0
      ? g.variations
      : flat.filter((v) => v.groupId === g.id)
    ).slice().sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    return { id: g.id, name: g.name, sortOrder: g.sortOrder ?? 0, variations: opts };
  });
}

/**
 * Mesmo `{ variations, variationLabel }` a partir de um item de `receiptSnapshot.products`
 * (sem RegistrationProduct vivo): `selectedVariations` (pedido novo) ou `selectedVariation`.
 */
export function describeSnapshotProductVariations(p: any): {
  variations: VariationChoice[];
  variationLabel: string;
} {
  const variations: VariationChoice[] = Array.isArray(p?.selectedVariations)
    ? p.selectedVariations
    : p?.selectedVariation?.name
      ? [{ id: p.selectedVariation.id ?? '', name: p.selectedVariation.name, groupId: null, groupName: null }]
      : [];
  return { variations, variationLabel: buildVariationLabel(variations) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Corpo cru (rotas sem DTO) da alteração de variação: `variationIds` (1 opção por variação)
 * vence; `variationId` = legado. Valida formato no boundary (uuid, até 20) → 400.
 */
export function parseVariationIdsBody(variationIds: unknown, variationId: unknown): string[] {
  const raw: unknown[] =
    Array.isArray(variationIds) && variationIds.length > 0
      ? variationIds
      : variationId != null && variationId !== ''
        ? [variationId]
        : [];
  if (raw.length === 0 || raw.length > 20 || raw.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
    throw new BadRequestException('Variação inválida para este produto');
  }
  return [...new Set(raw as string[])];
}
