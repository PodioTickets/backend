import {
  computeAnticipation,
  totalAvailableGross,
  unitCost,
  type AnticipationUnit,
} from '../anticipation-engine';

/**
 * Testes de CARACTERIZAÇÃO do motor de antecipação — os números batem 1:1 com os
 * exemplos de `frontend/adiantamento.md` (taxa mensal do doc = 10% = 0.10).
 * Valores em REAIS nos exemplos → aqui em CENTAVOS.
 */

const RATE = 0.1; // 10% a.m. (padrão do doc)

const unit = (
  o: Partial<AnticipationUnit> & Pick<AnticipationUnit, 'unitId' | 'gross' | 'daysUntilRelease'>,
): AnticipationUnit => ({
  orderId: o.unitId,
  paymentId: o.unitId,
  installmentNumber: null,
  ...o,
});

describe('unitCost', () => {
  it('custo = gross × taxa × dias/30', () => {
    // 30,00 × 0.10 × 16/30 = 1,60
    expect(unitCost(3000, 16, RATE)).toBe(160);
    // 30,00 × 0.10 × 46/30 = 4,60
    expect(unitCost(3000, 46, RATE)).toBe(460);
    // 30,00 × 0.10 × 76/30 = 7,60
    expect(unitCost(3000, 76, RATE)).toBe(760);
  });
});

describe('computeAnticipation — exemplos do adiantamento.md', () => {
  it('parcelado 3×30, antecipa tudo hoje (16/46/76 dias) → recebe 76,20', () => {
    const units = [
      unit({ unitId: 'p1', gross: 3000, daysUntilRelease: 16 }),
      unit({ unitId: 'p2', gross: 3000, daysUntilRelease: 46 }),
      unit({ unitId: 'p3', gross: 3000, daysUntilRelease: 76 }),
    ];
    // Antecipar tudo → pede o líquido total.
    const total = totalAvailableGross(units); // 9000
    const r = computeAnticipation(units, total, RATE);
    expect(r.consumedGross).toBe(9000);
    expect(r.realCost).toBe(160 + 460 + 760); // 1380
    expect(r.recommendedNet).toBe(9000 - 1380); // 7620 = R$ 76,20
    expect(r.receive).toBe(7620);
  });

  it('parcelado após 40 dias (2ª=21d, 3ª=51d) → recebe 52,80', () => {
    const units = [
      unit({ unitId: 'p2', gross: 3000, daysUntilRelease: 21 }),
      unit({ unitId: 'p3', gross: 3000, daysUntilRelease: 51 }),
    ];
    const total = totalAvailableGross(units); // 6000
    const r = computeAnticipation(units, total, RATE);
    // 2,10 + 5,10 = 7,20 de custo → 60,00 − 7,20 = 52,80
    expect(r.realCost).toBe(210 + 510);
    expect(r.recommendedNet).toBe(5280);
    expect(r.receive).toBe(5280);
  });

  it('2 à vista de 30 (31 dias), pede 50 → consome ambos; recomendado 53,80; taxa efetiva 16,67%', () => {
    const units = [
      unit({ unitId: 'a1', gross: 3000, daysUntilRelease: 31 }),
      unit({ unitId: 'a2', gross: 3000, daysUntilRelease: 31 }),
    ];
    const r = computeAnticipation(units, 5000, RATE);
    expect(r.consumedUnitIds).toEqual(['a1', 'a2']);
    expect(r.consumedGross).toBe(6000);
    expect(r.realCost).toBe(310 + 310); // 620
    expect(r.recommendedNet).toBe(5380); // 53,80
    expect(r.receive).toBe(5000);
    expect(r.effectiveFee).toBe(1000); // 60,00 − 50,00
    expect(r.effectiveRatePct).toBeCloseTo(16.666, 2);
  });

  it('mesmos 2 à vista, aceita o recomendado 53,80 → taxa efetiva 10,33%', () => {
    const units = [
      unit({ unitId: 'a1', gross: 3000, daysUntilRelease: 31 }),
      unit({ unitId: 'a2', gross: 3000, daysUntilRelease: 31 }),
    ];
    const r = computeAnticipation(units, 5380, RATE);
    expect(r.receive).toBe(5380);
    expect(r.effectiveFee).toBe(620);
    expect(r.effectiveRatePct).toBeCloseTo(10.333, 2);
  });

  it('mistura: parcela 1ª (10d) + à vista (31d) são as mais baratas; pede 50 → recomendado 55,90', () => {
    // Pool: 2 à vista (31d) + parcelado 3× (10/40/70d). Mais baratas: p1(10d) e um à vista(31d).
    const units = [
      unit({ unitId: 'a1', gross: 3000, daysUntilRelease: 31 }),
      unit({ unitId: 'a2', gross: 3000, daysUntilRelease: 31 }),
      unit({ unitId: 'p1', gross: 3000, daysUntilRelease: 10, installmentNumber: 1 }),
      unit({ unitId: 'p2', gross: 3000, daysUntilRelease: 40, installmentNumber: 2 }),
      unit({ unitId: 'p3', gross: 3000, daysUntilRelease: 70, installmentNumber: 3 }),
    ];
    const r = computeAnticipation(units, 5000, RATE);
    // Consome p1 (10d, custo 1,00) + um à vista (31d, custo 3,10) → líquido 29,00 + 26,90 = 55,90
    expect(r.consumedUnitIds).toEqual(['p1', 'a1']);
    expect(r.realCost).toBe(100 + 310); // 410
    expect(r.recommendedNet).toBe(5590); // 55,90
    // Se insistir em 50 → taxa efetiva 16,67%; se aceitar 55,90 → 6,83%.
    expect(r.receive).toBe(5000);
    expect(r.effectiveFee).toBe(1000);
    expect(r.effectiveRatePct).toBeCloseTo(16.666, 2);

    const rRec = computeAnticipation(units, 5590, RATE);
    expect(rRec.effectiveFee).toBe(410);
    expect(rRec.effectiveRatePct).toBeCloseTo(6.833, 2);
  });

  it('pedido 0 ou sem unidades → resultado vazio', () => {
    const units = [unit({ unitId: 'a1', gross: 3000, daysUntilRelease: 31 })];
    expect(computeAnticipation(units, 0, RATE).consumedGross).toBe(0);
    expect(computeAnticipation([], 5000, RATE).consumedGross).toBe(0);
  });

  it('pede mais do que o total possível → recebe o líquido total', () => {
    const units = [unit({ unitId: 'a1', gross: 3000, daysUntilRelease: 31 })];
    const r = computeAnticipation(units, 999999, RATE);
    expect(r.consumedGross).toBe(3000);
    expect(r.receive).toBe(3000 - 310); // 2690
    expect(r.recommendedNet).toBe(2690);
  });
});
