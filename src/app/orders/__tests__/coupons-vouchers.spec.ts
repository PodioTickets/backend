/**
 * ROTEIRO — Cupons & Vouchers (motor de desconto)
 * ================================================
 * Cobre TODA a mecânica de desconto do checkout, exercitando as funções puras exportadas
 * de `orders.service.ts` + a montagem/`re-derivação` do `orderShape`. Objetivo: blindar
 * contra regressões em cupom (DISCOUNT/QUANTITY/AGE), voucher e suas combinações.
 *
 *  A. computePartialCouponDiscount — base do desconto (PERCENTAGE/FIXED, usage, produtos, cap)
 *  B. distributeDiscount         — distribuição por unidade (qualifyingSlots, usage, FIXED clamp)
 *  C. resolveVoucherCoverage     — cobertura do voucher (appliesTo, exclude, eligibleSlots)
 *  D. computeDocEligibleSlots    — elegibilidade POR PARTICIPANTE (CPF/passaporte/lista)
 *  E. capUsageByMax              — limite de uso (maxUsage − usageCount)
 *  F. inferEffectiveUsage        — inferir nº de unidades a partir do desconto (pós-pago)
 *  G. orderShape                 — display + re-derivação (AGE/cpf/voucher, cap maxUsage, PENDING-only)
 *
 * Valores SEMPRE em centavos.
 */
import {
  computePartialCouponDiscount,
  distributeDiscount,
  resolveVoucherCoverage,
  computeDocEligibleSlots,
  capUsageByMax,
  inferEffectiveUsage,
  orderShape,
} from '../orders.service';

// ─── helpers ───────────────────────────────────────────────────────────────
const rt = (ticketId: string, quantity: number, unitPrice: number) => ({ ticketId, quantity, unitPrice });
const cpfDoc = (numberClean: string) => ({ type: 'CPF', numberClean });
const participantCpf = (cpf: string) => ({ documentType: 'CPF', documentNumber: cpf });
const discountedUnits = (units: any[]) => units.filter((u) => u.couponApplied);

describe('Cupons & Vouchers — motor de desconto', () => {
  // ── A. computePartialCouponDiscount ────────────────────────────────────────
  describe('A. computePartialCouponDiscount', () => {
    it('A1 PERCENTAGE: 50% sobre 1 de 2 ingressos @100 → 5000', () => {
      expect(computePartialCouponDiscount([rt('A', 2, 10000)], 'PERCENTAGE', 50, 1)).toBe(5000);
    });
    it('A2 PERCENTAGE: 50% sobre os 2 ingressos → 10000', () => {
      expect(computePartialCouponDiscount([rt('A', 2, 10000)], 'PERCENTAGE', 50, 2)).toBe(10000);
    });
    it('A3 FIXED: 30 por uso × 2 = 6000 (dentro do subtotal)', () => {
      expect(computePartialCouponDiscount([rt('A', 2, 10000)], 'FIXED', 3000, 2)).toBe(6000);
    });
    it('A4 FIXED: capa no preço do ingresso (cupom > ingresso)', () => {
      expect(computePartialCouponDiscount([rt('A', 1, 10000)], 'FIXED', 20000, 1)).toBe(10000);
    });
    it('A5 productsExtra (applyToProducts): produtos entram na base do PERCENTAGE', () => {
      // base = ingresso(10000) + produtos(2000) = 12000 → 50% = 6000
      expect(computePartialCouponDiscount([rt('A', 1, 10000)], 'PERCENTAGE', 50, 1, 2000)).toBe(6000);
    });
    it('A6 effectiveUsage 0 → desconto 0', () => {
      expect(computePartialCouponDiscount([rt('A', 2, 10000)], 'PERCENTAGE', 50, 0)).toBe(0);
    });
    it('A7 escolhe os ingressos MAIS CAROS dentro do uso', () => {
      // mix 5000 + 10000, usage 1 → pega o de 10000 → 50% = 5000
      expect(computePartialCouponDiscount([rt('A', 1, 5000), rt('B', 1, 10000)], 'PERCENTAGE', 50, 1)).toBe(5000);
    });
  });

  // ── B. distributeDiscount ──────────────────────────────────────────────────
  describe('B. distributeDiscount', () => {
    it('B1 sem qualifyingSlots: aplica no ingresso mais caro', () => {
      const units = distributeDiscount([rt('A', 1, 5000), rt('B', 1, 10000)], 5000, 1);
      expect(units[0].couponApplied).toBe(false); // 5000
      expect(units[1].unitDiscount).toBe(5000); // 10000 (mais caro)
    });
    it('B2 com qualifyingSlots: aplica no slot indicado (não no mais caro)', () => {
      const units = distributeDiscount([rt('A', 1, 5000), rt('B', 1, 10000)], 2500, 1, undefined, [0]);
      expect(units[0].unitDiscount).toBe(2500); // slot 0 (5000), elegível
      expect(units[1].couponApplied).toBe(false); // slot 1 (10000) NÃO recebe
    });
    it('B3 qualifyingSlots > coveredQty: usa os primeiros coveredQty', () => {
      const units = distributeDiscount([rt('A', 2, 10000)], 5000, 1, undefined, [0, 1]);
      expect(discountedUnits(units).length).toBe(1);
      expect(units[0].couponApplied).toBe(true); // primeiro slot qualificado
    });
    it('B4 qualifyingSlots < coveredQty: completa por preço', () => {
      const units = distributeDiscount([rt('A', 1, 5000), rt('B', 1, 10000)], 15000, 2, undefined, [0]);
      expect(discountedUnits(units).length).toBe(2); // slot0 + completa com slot1
    });
    it('B5 FIXED: clampa o desconto por slot no preço do ingresso', () => {
      const units = distributeDiscount([rt('A', 1, 10000)], 20000, 1, 20000);
      expect(units[0].unitDiscount).toBe(10000); // não passa do unitPrice
      expect(units[0].finalUnitPrice).toBe(0);
    });
    it('B6 totalDiscount 0 → nenhuma unidade com desconto', () => {
      const units = distributeDiscount([rt('A', 2, 10000)], 0, 2);
      expect(discountedUnits(units).length).toBe(0);
    });
  });

  // ── C. resolveVoucherCoverage (voucher = 1 ingresso grátis) ─────────────────
  describe('C. resolveVoucherCoverage', () => {
    const tickets = [rt('A', 1, 5000), rt('B', 1, 10000)];
    it('C1 appliesTo all: cobre o ingresso mais caro', () => {
      const cov = resolveVoucherCoverage(tickets, 'all');
      expect(cov.hasApplicable).toBe(true);
      expect(cov.discount).toBe(10000);
      expect(cov.qualifyingSlot).toBe(1);
    });
    it('C2 appliesTo restrito: cobre o mais caro entre os permitidos', () => {
      const cov = resolveVoucherCoverage(tickets, 'A'); // só ticket A
      expect(cov.discount).toBe(5000);
      expect(cov.qualifyingSlot).toBe(0);
    });
    it('C3 excludeTicketIds (combinado c/ cupom): ignora os já cobertos', () => {
      const cov = resolveVoucherCoverage(tickets, 'all', new Set(['B']));
      expect(cov.discount).toBe(5000); // B excluído → sobra A
      expect(cov.qualifyingSlot).toBe(0);
    });
    it('C4 eligibleSlots (cpf): cobre só a unidade do participante elegível', () => {
      // slot0 = A@5000 elegível; slot1 = B@10000 NÃO elegível → cobre 5000 (não o mais caro)
      const cov = resolveVoucherCoverage(tickets, 'all', undefined, new Set([0]));
      expect(cov.discount).toBe(5000);
      expect(cov.qualifyingSlot).toBe(0);
    });
    it('C5 nenhum aplicável → hasApplicable false, discount 0', () => {
      const cov = resolveVoucherCoverage(tickets, 'INEXISTENTE');
      expect(cov.hasApplicable).toBe(false);
      expect(cov.discount).toBe(0);
      expect(cov.qualifyingSlot).toBe(-1);
    });
  });

  // ── D. computeDocEligibleSlots (elegibilidade por participante) ─────────────
  describe('D. computeDocEligibleSlots', () => {
    it('D1 CPF na lista → slot incluído', () => {
      expect(
        computeDocEligibleSlots([participantCpf('11111111111')], [cpfDoc('11111111111')], null, 1),
      ).toEqual([0]);
    });
    it('D2 CPF fora da lista → excluído', () => {
      expect(
        computeDocEligibleSlots([participantCpf('99999999999')], [cpfDoc('11111111111')], null, 1),
      ).toEqual([]);
    });
    it('D3 PASSPORT na documentList → incluído', () => {
      const p = [{ documentType: 'PASSPORT', documentNumber: 'AB12345' }];
      expect(
        computeDocEligibleSlots(p, [{ type: 'PASSPORT', numberClean: 'AB12345' }], null, 1),
      ).toEqual([0]);
    });
    it('D4 participante sem documento → excluído', () => {
      expect(computeDocEligibleSlots([{}], [cpfDoc('11111111111')], null, 1)).toEqual([]);
    });
    it('D5 participante além de totalUnits → excluído', () => {
      // 2 participantes elegíveis, mas só 1 unidade reservada → só o slot 0 conta
      const ps = [participantCpf('11111111111'), participantCpf('11111111111')];
      expect(computeDocEligibleSlots(ps, [cpfDoc('11111111111')], null, 1)).toEqual([0]);
    });
    it('D6 fallback cpfList legado (sem documentList)', () => {
      expect(
        computeDocEligibleSlots([participantCpf('11111111111')], null, ['11111111111'], 1),
      ).toEqual([0]);
    });
    it('D7 múltiplos: retorna só os índices elegíveis', () => {
      const ps = [participantCpf('11111111111'), participantCpf('99999999999'), participantCpf('11111111111')];
      expect(computeDocEligibleSlots(ps, [cpfDoc('11111111111')], null, 3)).toEqual([0, 2]);
    });
  });

  // ── E. capUsageByMax (limite de uso) ────────────────────────────────────────
  describe('E. capUsageByMax', () => {
    it('E1 maxUsage null → não capa', () => {
      expect(capUsageByMax(3, { maxUsage: null, usageCount: 0 })).toBe(3);
    });
    it('E2 maxUsage 1, usageCount 0 → capa em 1', () => {
      expect(capUsageByMax(2, { maxUsage: 1, usageCount: 0 })).toBe(1);
    });
    it('E3 maxUsage 3, usageCount 2 → restante 1', () => {
      expect(capUsageByMax(5, { maxUsage: 3, usageCount: 2 })).toBe(1);
    });
    it('E4 esgotado (usageCount >= maxUsage) → 0', () => {
      expect(capUsageByMax(2, { maxUsage: 1, usageCount: 1 })).toBe(0);
    });
  });

  // ── F. inferEffectiveUsage (pós-pago: deduz nº de unidades do desconto) ──────
  describe('F. inferEffectiveUsage', () => {
    it('F1 PERCENTAGE: desconto = 50% de 1 ingresso → n=1', () => {
      expect(inferEffectiveUsage([rt('A', 2, 10000)], { type: 'PERCENTAGE', value: 50 }, 5000)).toBe(1);
    });
    it('F2 FIXED: desconto múltiplo do valor → n', () => {
      expect(inferEffectiveUsage([rt('A', 2, 10000)], { type: 'FIXED', value: 3000 }, 6000)).toBe(2);
    });
    it('F3 desconto não inferível → undefined', () => {
      expect(inferEffectiveUsage([rt('A', 2, 10000)], { type: 'PERCENTAGE', value: 50 }, 7777)).toBeUndefined();
    });
  });

  // ── G. orderShape — display + re-derivação ──────────────────────────────────
  describe('G. orderShape (display + re-derivação)', () => {
    // Order mínimo p/ orderShape (PENDING → serviceFee on-the-fly = 0).
    const baseOrder = (over: any = {}) => ({
      id: 'o1',
      eventId: 'evt-1',
      status: 'PENDING',
      totalAmount: 20000,
      discount: 0,
      serviceFee: 0,
      finalAmount: 20000,
      event: { participantFeePercent: 0, eventDate: '2026-12-01' },
      coupon: null,
      voucher: null,
      couponId: null,
      voucherId: null,
      payment: null,
      reservedTickets: [rt('A', 2, 10000)],
      pendingParticipants: null,
      pendingProducts: null,
      ...over,
    });
    const ageCoupon = (over: any = {}) => ({
      id: 'age-1', couponType: 'AGE', type: 'PERCENTAGE', value: 50, appliesTo: 'all',
      minAge: 0, maxAge: 200, applyToProducts: false, cpfListStatus: 'DISABLED',
      documentList: null, cpfList: null, maxUsage: null, usageCount: 0, ...over,
    });

    it('G1 AGE: re-deriva elegíveis de pendingParticipants (PENDING) e recomputa o desconto', () => {
      const shaped = orderShape(baseOrder({
        coupon: ageCoupon(),
        couponId: 'age-1',
        discount: 0, // defasado — orderShape recomputa
        pendingParticipants: [{ birthDate: '1990-01-01' }, { birthDate: '1992-01-01' }],
      }));
      expect(shaped.discount).toBe(10000); // 2 elegíveis
      expect(discountedUnits(shaped.reservedTickets).length).toBe(2);
    });

    it('G2 AGE maxUsage=1 + 2 elegíveis → capa em 1 ingresso', () => {
      const shaped = orderShape(baseOrder({
        coupon: ageCoupon({ maxUsage: 1, usageCount: 0 }),
        couponId: 'age-1',
        discount: 10000, // defasado (2 ingressos) — deve recapar
        pendingParticipants: [{ birthDate: '1990-01-01' }, { birthDate: '1992-01-01' }],
      }));
      expect(shaped.discount).toBe(5000);
      expect(discountedUnits(shaped.reservedTickets).length).toBe(1);
    });

    it('G3 AGE PAID: NÃO re-deriva — mantém o desconto congelado (não infla)', () => {
      const shaped = orderShape(baseOrder({
        status: 'PAID',
        serviceFee: 1, // pago → finalAmount congelado
        coupon: ageCoupon({ maxUsage: 1, usageCount: 1 }),
        couponId: 'age-1',
        discount: 5000, // valor cobrado (1 ingresso)
        finalAmount: 15000,
        pendingParticipants: [{ birthDate: '1990-01-01' }, { birthDate: '1992-01-01' }],
      }));
      expect(shaped.discount).toBe(5000); // não vira 10000
      expect(discountedUnits(shaped.reservedTickets).length).toBe(1);
    });

    it('G4 cupom DISCOUNT c/ lista de documento: aplica só nos participantes elegíveis', () => {
      const shaped = orderShape(baseOrder({
        coupon: {
          id: 'cpn-1', couponType: 'DISCOUNT', type: 'PERCENTAGE', value: 50, appliesTo: 'all',
          minAge: null, maxAge: null, applyToProducts: false, cpfListStatus: 'ENABLED',
          documentList: [cpfDoc('11111111111')], cpfList: null, maxUsage: null, usageCount: 0,
        },
        couponId: 'cpn-1',
        discount: 0,
        pendingParticipants: [participantCpf('11111111111'), participantCpf('99999999999')],
      }));
      expect(shaped.discount).toBe(5000); // 1 elegível de 2
      expect(discountedUnits(shaped.reservedTickets).length).toBe(1);
    });

    it('G5 voucher sozinho (PENDING): 1 ingresso grátis = o mais caro', () => {
      const shaped = orderShape(baseOrder({
        voucher: { id: 'v1', appliesTo: 'all', applyToProducts: false, cpfListStatus: 'DISABLED', documentList: null, cpfList: null },
        voucherId: 'v1',
        discount: 0,
        reservedTickets: [rt('A', 1, 5000), rt('B', 1, 10000)],
        totalAmount: 15000,
      }));
      expect(shaped.discount).toBe(10000);
      expect(shaped.pricing.voucherDiscount).toBe(10000);
      expect(shaped.pricing.couponDiscount).toBe(0);
    });

    it('G6 voucher c/ lista de documento: cobre só o ingresso do participante elegível', () => {
      const shaped = orderShape(baseOrder({
        voucher: { id: 'v1', appliesTo: 'all', applyToProducts: false, cpfListStatus: 'ENABLED', documentList: [cpfDoc('11111111111')], cpfList: null },
        voucherId: 'v1',
        discount: 0,
        // slot0 = A@5000 (elegível); slot1 = B@10000 (não)
        reservedTickets: [rt('A', 1, 5000), rt('B', 1, 10000)],
        totalAmount: 15000,
        pendingParticipants: [participantCpf('11111111111'), participantCpf('99999999999')],
      }));
      expect(shaped.discount).toBe(5000); // o do elegível, NÃO o mais caro
    });

    it('G7 pricing breakdown: couponDiscount + voucherDiscount == discount (combinado)', () => {
      const shaped = orderShape(baseOrder({
        coupon: { id: 'cpn-1', couponType: 'DISCOUNT', type: 'PERCENTAGE', value: 50, appliesTo: 'A', minAge: null, maxAge: null, applyToProducts: false, cpfListStatus: 'DISABLED', documentList: null, cpfList: null, maxUsage: null, usageCount: 0 },
        couponId: 'cpn-1',
        voucher: { id: 'v1', appliesTo: 'all', applyToProducts: false, cpfListStatus: 'DISABLED', documentList: null, cpfList: null },
        voucherId: 'v1',
        discount: 7500, // 50% de A(5000)=2500 + voucher cobre B(10000)... clamp; soma deve bater
        reservedTickets: [rt('A', 1, 5000), rt('B', 1, 10000)],
        totalAmount: 15000,
      }));
      expect(shaped.pricing.couponDiscount + shaped.pricing.voucherDiscount).toBe(shaped.discount);
    });

    it('G8 cupom FIXED: per-unit clampado no preço do ingresso no display', () => {
      const shaped = orderShape(baseOrder({
        coupon: { id: 'cpn-f', couponType: 'DISCOUNT', type: 'FIXED', value: 20000, appliesTo: 'all', minAge: null, maxAge: null, applyToProducts: false, cpfListStatus: 'DISABLED', documentList: null, cpfList: null, maxUsage: null, usageCount: 0 },
        couponId: 'cpn-f',
        discount: 10000, // FIXED 20000 capado no ingresso @10000
        reservedTickets: [rt('A', 1, 10000)],
        totalAmount: 10000,
      }), 10000, undefined, 1, 20000);
      const u = shaped.reservedTickets[0];
      expect(u.unitDiscount).toBe(10000); // clamp no unitPrice
      expect(u.finalUnitPrice).toBe(0);
    });
  });

  // ── H. ADVERSARIAL / edge cases (tentando quebrar) ──────────────────────────
  describe('H. adversarial / edge cases', () => {
    // H-A computePartialCouponDiscount
    it('HA1 effectiveUsage > unidades disponíveis → capa nas existentes', () => {
      expect(computePartialCouponDiscount([rt('A', 1, 10000)], 'PERCENTAGE', 50, 5)).toBe(5000);
    });
    it('HA2 effectiveUsage negativo → 0', () => {
      expect(computePartialCouponDiscount([rt('A', 2, 10000)], 'PERCENTAGE', 50, -3)).toBe(0);
    });
    it('HA3 productsBaseExtra negativo é ignorado (não reduz a base)', () => {
      expect(computePartialCouponDiscount([rt('A', 1, 10000)], 'PERCENTAGE', 50, 1, -9999)).toBe(5000);
    });
    it('HA4 PERCENTAGE 100% → zera o ingresso', () => {
      expect(computePartialCouponDiscount([rt('A', 1, 10000)], 'PERCENTAGE', 100, 1)).toBe(10000);
    });
    it('HA5 FIXED value 0 → 0', () => {
      expect(computePartialCouponDiscount([rt('A', 2, 10000)], 'FIXED', 0, 2)).toBe(0);
    });
    it('HA6 sem ingressos → 0', () => {
      expect(computePartialCouponDiscount([], 'PERCENTAGE', 50, 1)).toBe(0);
    });

    // H-B distributeDiscount
    it('HB1 qualifyingSlots fora do range → cai pro fallback por preço (não quebra)', () => {
      const units = distributeDiscount([rt('A', 1, 5000), rt('B', 1, 10000)], 10000, 1, undefined, [99, -1]);
      expect(discountedUnits(units).length).toBe(1);
      expect(units[1].couponApplied).toBe(true); // fallback no mais caro
    });
    it('HB2 qualifyingSlots duplicados não duplicam cobertura', () => {
      const units = distributeDiscount([rt('A', 2, 10000)], 5000, 1, undefined, [0, 0, 0]);
      expect(discountedUnits(units).length).toBe(1);
    });
    it('HB3 sem ingressos → []', () => {
      expect(distributeDiscount([], 5000, 1)).toEqual([]);
    });
    it('HB4 PERCENTAGE: desconto por slot nunca passa do unitPrice (totalDiscount gigante)', () => {
      const units = distributeDiscount([rt('A', 1, 5000), rt('B', 1, 10000)], 999999, 2);
      expect(units.every((u) => u.unitDiscount <= u.unitPrice)).toBe(true);
      expect(units.every((u) => u.finalUnitPrice >= 0)).toBe(true);
    });
    it('HB5 effectiveUsage > totalQuantity → cobre todas as unidades, sem estourar', () => {
      const units = distributeDiscount([rt('A', 2, 10000)], 20000, 99);
      expect(discountedUnits(units).length).toBe(2);
    });

    // H-C resolveVoucherCoverage
    it('HC1 sem ingressos → não aplicável', () => {
      expect(resolveVoucherCoverage([], 'all').hasApplicable).toBe(false);
    });
    it('HC2 eligibleSlots vazio → não aplicável (nenhum participante elegível)', () => {
      const cov = resolveVoucherCoverage([rt('A', 1, 10000)], 'all', undefined, new Set<number>());
      expect(cov.hasApplicable).toBe(false);
      expect(cov.discount).toBe(0);
    });
    it('HC3 ingresso com quantity 0 é ignorado', () => {
      const cov = resolveVoucherCoverage([rt('A', 0, 10000), rt('B', 1, 5000)], 'all');
      expect(cov.discount).toBe(5000);
    });

    // H-D computeDocEligibleSlots
    it('HD1 sem participantes → []', () => {
      expect(computeDocEligibleSlots([], [cpfDoc('11111111111')], null, 2)).toEqual([]);
    });
    it('HD2 totalUnits 0 → [] (nenhum slot reservado)', () => {
      expect(computeDocEligibleSlots([participantCpf('11111111111')], [cpfDoc('11111111111')], null, 0)).toEqual([]);
    });
    it('HD3 documentList e cpfList vazios → [] (nada elegível)', () => {
      expect(computeDocEligibleSlots([participantCpf('11111111111')], [], [], 1)).toEqual([]);
    });
    it('HD4 número igual mas TIPO diferente (CPF vs PASSPORT) → NÃO casa', () => {
      const ps = [{ documentType: 'CPF', documentNumber: '12345678901' }];
      expect(computeDocEligibleSlots(ps, [{ type: 'PASSPORT', numberClean: '12345678901' }], null, 1)).toEqual([]);
    });
    it('HD5 documento formatado no participante é normalizado antes de comparar', () => {
      const ps = [{ documentType: 'CPF', documentNumber: '111.111.111-11' }];
      expect(computeDocEligibleSlots(ps, [cpfDoc('11111111111')], null, 1)).toEqual([0]);
    });

    // H-E capUsageByMax
    it('HE1 usageCount > maxUsage → 0 (remaining nunca negativo)', () => {
      expect(capUsageByMax(3, { maxUsage: 1, usageCount: 5 })).toBe(0);
    });
    it('HE2 count 0 → 0', () => {
      expect(capUsageByMax(0, { maxUsage: 10, usageCount: 0 })).toBe(0);
    });

    // H-G orderShape
    it('HG1 AGE sem pendingParticipants → não quebra, usa inferEffectiveUsage do discount', () => {
      const shaped = orderShape({
        id: 'o', eventId: 'e', status: 'PENDING', totalAmount: 20000, discount: 5000, serviceFee: 0,
        finalAmount: 15000, event: { participantFeePercent: 0, eventDate: '2026-12-01' },
        coupon: { id: 'age', couponType: 'AGE', type: 'PERCENTAGE', value: 50, appliesTo: 'all', minAge: 0, maxAge: 200, applyToProducts: false, cpfListStatus: 'DISABLED', documentList: null, cpfList: null, maxUsage: null, usageCount: 0 },
        couponId: 'age', voucher: null, voucherId: null, payment: null,
        reservedTickets: [rt('A', 2, 10000)], pendingParticipants: null, pendingProducts: null,
      });
      expect(shaped.discount).toBe(5000); // mantém o persistido
      expect(discountedUnits(shaped.reservedTickets).length).toBe(1);
    });
    it('HG2 AGE esgotado (usageCount=maxUsage) → desconto 0 mesmo com elegíveis', () => {
      const shaped = orderShape({
        id: 'o', eventId: 'e', status: 'PENDING', totalAmount: 20000, discount: 5000, serviceFee: 0,
        finalAmount: 15000, event: { participantFeePercent: 0, eventDate: '2026-12-01' },
        coupon: { id: 'age', couponType: 'AGE', type: 'PERCENTAGE', value: 50, appliesTo: 'all', minAge: 0, maxAge: 200, applyToProducts: false, cpfListStatus: 'DISABLED', documentList: null, cpfList: null, maxUsage: 1, usageCount: 1 },
        couponId: 'age', voucher: null, voucherId: null, payment: null,
        reservedTickets: [rt('A', 2, 10000)],
        pendingParticipants: [{ birthDate: '1990-01-01' }, { birthDate: '1991-01-01' }], pendingProducts: null,
      });
      expect(shaped.discount).toBe(0); // remaining 0 → nada aplicado
      expect(discountedUnits(shaped.reservedTickets).length).toBe(0);
    });
    it('HG3 QUANTITY com cpfListStatus ENABLED → NÃO é restrito por documento (desconto cheio)', () => {
      const shaped = orderShape({
        id: 'o', eventId: 'e', status: 'PENDING', totalAmount: 20000, discount: 2000, serviceFee: 0,
        finalAmount: 18000, event: { participantFeePercent: 0, eventDate: '2026-12-01' },
        coupon: { id: 'q', couponType: 'QUANTITY', type: 'PERCENTAGE', value: 10, appliesTo: 'all', minAge: null, maxAge: null, applyToProducts: false, cpfListStatus: 'ENABLED', documentList: [cpfDoc('11111111111')], cpfList: null, maxUsage: null, usageCount: 0 },
        couponId: 'q', voucher: null, voucherId: null, payment: null,
        reservedTickets: [rt('A', 2, 10000)],
        // 1 participante NÃO elegível por CPF — não deve cortar o desconto QUANTITY
        pendingParticipants: [participantCpf('11111111111'), participantCpf('99999999999')], pendingProducts: null,
      });
      expect(shaped.discount).toBe(2000); // desconto QUANTITY cheio, sem corte por cpf
      expect(discountedUnits(shaped.reservedTickets).length).toBe(2);
    });
  });
});
