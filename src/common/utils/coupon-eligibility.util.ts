/* eslint-disable @typescript-eslint/no-explicit-any */
import { isDocumentInList, resolveDocument } from './document.util';
import { computeAgeAt } from './age.util';
import { parseAppliesToArray } from '../../helpers/AppliesToHelper';

/**
 * Helpers PUROS de elegibilidade de cupom/voucher POR PARTICIPANTE.
 *
 * Vivem aqui (util neutro) e NÃO em `orders.service.ts` para que o
 * `OrderFinalizationService` (PaymentsModule) possa reusar a MESMA regra de "quantos
 * ingressos o cupom cobre" sem importar o OrdersService — evita o ciclo
 * OrdersModule ↔ PaymentsModule. `orders.service.ts` re-exporta estes helpers para
 * manter os imports/specs existentes.
 *
 * Dependem só de utils neutros (`document.util`, `age.util`, `AppliesToHelper`).
 */

/**
 * Slots (índices) elegíveis pela lista de documento. Participante PREENCHIDO (com documento)
 * só conta se o doc estiver na lista. Participante AINDA SEM documento:
 *   - `treatUnfilledAsEligible=true` (preenchimento/PENDING): conta como elegível → mantém o
 *     cupom/voucher aplicado no slot enquanto o comprador não preenche aquele participante.
 *   - `false` (default, momento do pay): NÃO conta — no commit final, só quem informou um
 *     documento válido (na lista) recebe o desconto cpf.
 */
export function computeDocEligibleSlots(
  participants: any[],
  documentList: unknown,
  cpfList: unknown,
  totalUnits: number,
  treatUnfilledAsEligible = false,
): number[] {
  return (participants ?? [])
    .map((p: any, i: number) => {
      if (i >= totalUnits) return -1;
      const doc = resolveDocument(p);
      if (!doc.clean) return treatUnfilledAsEligible ? i : -1;
      return isDocumentInList(
        { documentType: doc.type, documentNumberClean: doc.clean },
        documentList,
        cpfList,
      )
        ? i
        : -1;
    })
    .filter((i: number) => i >= 0);
}

/**
 * Slots elegíveis de um VOUCHER com lista de documento, em PENDING.
 *
 * Diferente do cupom DISCOUNT (que aplica desconto em CADA participante elegível,
 * independentemente), o voucher é **um único ingresso grátis** — só pode cobrir UMA
 * unidade por vez. Por isso o slot vazio NÃO é par-igual ao preenchido: ele é um
 * **fallback provisório**, não um elegível concorrente.
 *
 * Prioridade (regra do produto):
 *   1. Há ≥1 participante PREENCHIDO com documento na lista → elegíveis = só esses
 *      (slots vazios são EXCLUÍDOS; o voucher "desaplica" deles).
 *   2. Nenhum preenchido elegível → elegíveis = os slots AINDA VAZIOS (mantém o voucher
 *      aplicado provisoriamente até o comprador preencher e revalidar).
 *   3. Todos preenchidos e nenhum na lista → vazio (o caller rejeita com VOUCHER_CPF_RESTRICTED).
 *
 * Participante preenchido mas FORA da lista nunca entra (nem como fallback).
 * `resolveVoucherCoverage` depois escolhe, entre os elegíveis, a unidade aplicável mais cara.
 */
export function computeVoucherEligibleSlots(
  participants: any[],
  documentList: unknown,
  cpfList: unknown,
  totalUnits: number,
): number[] {
  const filledEligible = computeDocEligibleSlots(participants, documentList, cpfList, totalUnits, false);
  if (filledEligible.length > 0) return filledEligible;

  // Fallback provisório: slots ainda sem documento (vazios). Preenchido-mas-fora-da-lista
  // tem doc.clean e portanto NÃO entra aqui.
  const unfilled: number[] = [];
  for (let i = 0; i < totalUnits; i++) {
    const p = (participants ?? [])[i];
    const doc = p ? resolveDocument(p) : { clean: '' as string };
    if (!doc.clean) unfilled.push(i);
  }
  return unfilled;
}

/**
 * Slots (índices) elegíveis pelo cupom AGE (idade na data do evento). Mesma semântica de
 * `computeDocEligibleSlots`, mas a validação é por idade:
 *   - Participante COM `birthDate`: conta só se a idade ∈ [minAge, maxAge].
 *   - Participante AINDA SEM `birthDate` (slot não preenchido):
 *       `treatUnfilledAsEligible=true` (preenchimento/PENDING) → conta (mantém aplicado até preencher);
 *       `false` (default, pay) → não conta (no commit só idade informada e válida recebe).
 */
export function computeAgeEligibleSlots(
  participants: any[],
  minAge: number,
  maxAge: number,
  refDate: Date,
  totalUnits: number,
  treatUnfilledAsEligible = false,
): number[] {
  return (participants ?? [])
    .map((p: any, i: number) => {
      if (i >= totalUnits) return -1;
      if (!p.birthDate) return treatUnfilledAsEligible ? i : -1;
      const age = computeAgeAt(p.birthDate, refDate);
      return age >= minAge && age <= maxAge ? i : -1;
    })
    .filter((i: number) => i >= 0);
}

/**
 * Slots elegíveis de um cupom AGE, opcionalmente restringidos pela LISTA DE
 * DOCUMENTO exclusiva (`cpfListStatus === 'ENABLED'`).
 *
 * Regra do produto (confirmada 2026-08-14): **idade E lista (interseção)** — o
 * participante só recebe o desconto se estiver na faixa etária E com o documento
 * na lista. Com a lista DISABLED, equivale a `computeAgeEligibleSlots` puro.
 *
 * `treatUnfilledAsEligible` propaga para AMBAS as checagens (idade e documento),
 * mantendo o desconto PROVISÓRIO no PENDING até o participante ser preenchido —
 * espelha exatamente o comportamento consolidado do DISCOUNT+cpfList.
 *
 * Fonte ÚNICA da regra AGE+lista: todos os call-sites (reserve provisório,
 * re-avaliação de PATCH, pay estrito, cobertura de uso) passam por aqui.
 */
export function computeAgeCouponEligibleSlots(
  participants: any[],
  coupon: {
    minAge?: number | null;
    maxAge?: number | null;
    cpfListStatus?: string | null;
    documentList?: unknown;
    cpfList?: unknown;
  },
  refDate: Date,
  totalUnits: number,
  treatUnfilledAsEligible = false,
): number[] {
  const ageSlots = computeAgeEligibleSlots(
    participants ?? [],
    coupon.minAge ?? 0,
    coupon.maxAge ?? Number.POSITIVE_INFINITY,
    refDate,
    totalUnits,
    treatUnfilledAsEligible,
  );
  if (coupon.cpfListStatus !== 'ENABLED') return ageSlots;

  // Interseção com os slots elegíveis por documento (mesma semântica lenient/estrita).
  const docSlots = new Set(
    computeDocEligibleSlots(
      participants ?? [],
      coupon.documentList,
      coupon.cpfList,
      totalUnits,
      treatUnfilledAsEligible,
    ),
  );
  return ageSlots.filter((i) => docSlots.has(i));
}

/**
 * Nº de INGRESSOS efetivamente cobertos por um cupom — base canônica do incremento de
 * `usageCount` no finalize (e do decremento no estorno). Espelha EXATAMENTE a regra de
 * `effectiveUsage` do `pay`, garantindo que o uso contabilizado = ingressos que de fato
 * receberam o desconto (NÃO o total de ingressos do pedido — esse era o bug que mostrava
 * "2 usos" num pedido de 2 ingressos com o cupom aplicado em só 1).
 *
 * - **QUANTITY**: all-or-nothing por valor de carrinho → 1 uso por pedido (não por ingresso).
 * - **AGE**: `min(participantes na faixa de idade na data do evento, ingressos aplicáveis)`.
 * - **DISCOUNT + cpfList**: `min(participantes com documento na lista, ingressos aplicáveis)`.
 * - **DISCOUNT sem lista**: todos os ingressos aplicáveis (`appliesTo`).
 *
 * NÃO capa por `maxUsage` — o caller aplica o `remaining` (`maxUsage − usageCount`) + cap
 * atômico no SQL. Elegibilidade é ESTRITA (slot vazio não conta) — no finalize todos os
 * participantes já estão preenchidos (`pay` exige `INCOMPLETE_PARTICIPANTS`).
 */
export function computeCouponCoveredUnits(
  coupon: {
    couponType?: string | null;
    appliesTo?: string | null;
    cpfListStatus?: string | null;
    documentList?: unknown;
    cpfList?: unknown;
    minAge?: number | null;
    maxAge?: number | null;
  } | null | undefined,
  reservedTickets: any[],
  participants: any[],
  ageRefDate: Date,
): number {
  if (!coupon) return 0;
  // QUANTITY é all-or-nothing (1 uso/pedido); o caller trata separado, mas guardamos aqui também.
  if (coupon.couponType === 'QUANTITY') return 1;

  const totalUnits = (reservedTickets ?? []).reduce((s: number, rt: any) => s + (rt.quantity ?? 0), 0);

  let applicable = reservedTickets ?? [];
  if (coupon.appliesTo && coupon.appliesTo !== 'all') {
    const allowed = parseAppliesToArray(coupon.appliesTo);
    applicable = applicable.filter((rt: any) => allowed.includes(rt.ticketId));
  }
  const applicableQty = applicable.reduce((s: number, rt: any) => s + (rt.quantity ?? 0), 0);
  if (applicableQty === 0) return 0;

  if (coupon.couponType === 'AGE') {
    // AGE respeita a lista exclusiva de documento quando ENABLED (idade E lista).
    const ageMatch = computeAgeCouponEligibleSlots(
      participants ?? [],
      coupon as any,
      ageRefDate,
      totalUnits,
    ).length;
    return Math.min(ageMatch, applicableQty);
  }

  // DISCOUNT
  if (coupon.cpfListStatus === 'ENABLED') {
    const docCount = computeDocEligibleSlots(
      participants ?? [],
      coupon.documentList,
      coupon.cpfList,
      totalUnits,
    ).length;
    return Math.min(docCount, applicableQty);
  }
  return applicableQty;
}
