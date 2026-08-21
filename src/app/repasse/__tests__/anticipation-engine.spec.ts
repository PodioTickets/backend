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

  it('mistura 5 unidades de R$30, pede 50: min gross (2 unidades) e desempate = recomendado + perto de 50', () => {
    // Pool: 2 à vista (31d) + parcelado 3× (10/40/70d). Todas gross 3000 → qualquer
    // PAR consome 6000 (mesma taxa 16,67% p/ 50). O desempate (recomendado mais perto
    // de 50) escolhe o par cujo líquido é o menor ≥ 50 = p1(10d,29,00)+p3(70d,23,00)=52,00.
    const units = [
      unit({ unitId: 'a1', gross: 3000, daysUntilRelease: 31 }),
      unit({ unitId: 'a2', gross: 3000, daysUntilRelease: 31 }),
      unit({ unitId: 'p1', gross: 3000, daysUntilRelease: 10, installmentNumber: 1 }),
      unit({ unitId: 'p2', gross: 3000, daysUntilRelease: 40, installmentNumber: 2 }),
      unit({ unitId: 'p3', gross: 3000, daysUntilRelease: 70, installmentNumber: 3 }),
    ];
    const r = computeAnticipation(units, 5000, RATE);
    expect(r.consumedUnitIds).toEqual(['p1', 'p3']);
    expect(r.consumedGross).toBe(6000);
    expect(r.realCost).toBe(100 + 700); // p1(10d)=1,00 + p3(70d)=7,00 = 8,00
    expect(r.recommendedNet).toBe(5200); // 52,00 (o mais perto de 50 dentre os pares)
    expect(r.receive).toBe(5000);
    expect(r.effectiveFee).toBe(1000); // 6000 − 5000 (mesma taxa de qualquer par)
    expect(r.effectiveRatePct).toBeCloseTo(16.666, 2);

    // Pedindo exatamente 55,90 → precisa de um par com líquido ≥ 5590: p1+a1 (5590).
    const rRec = computeAnticipation(units, 5590, RATE);
    expect(rRec.recommendedNet).toBe(5590);
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

describe('computeAnticipation — SELEÇÃO ÓTIMA (menor taxa, sem estouro do greedy)', () => {
  it('mesmo dia: prefere a unidade GRANDE sozinha a somar a pequena+grande', () => {
    // 31 dias: A=R$10 (líq 8,97), B=R$100 (líq 89,67). Pede R$15.
    // Greedy antigo (menor gross 1º): pega A, ainda falta → soma B → gross 110.
    // Ótimo: só B já cobre (89,67 ≥ 15) → gross 100 → taxa menor.
    const units = [
      unit({ unitId: 'a', gross: 1000, daysUntilRelease: 31 }),
      unit({ unitId: 'b', gross: 10000, daysUntilRelease: 31 }),
    ];
    const r = computeAnticipation(units, 1500, RATE);
    expect(r.consumedUnitIds).toEqual(['b']);
    expect(r.consumedGross).toBe(10000);
    expect(r.receive).toBe(1500);
    expect(r.effectiveFee).toBe(8500); // 100,00 − 15,00 (antes seria 95,00 com A+B)
  });

  it('mesmo dia (0d, sem custo): escolhe o subconjunto de menor gross que cobre', () => {
    // Sem custo (0 dias): líquido = gross. Grosses 3/5/8, pede líquido 9.
    // Greedy asc somaria 3+5+8=16; ótimo é {3,8}=11 (cobre 9 com menor gross).
    const units = [
      unit({ unitId: 'u3', gross: 300, daysUntilRelease: 0 }),
      unit({ unitId: 'u5', gross: 500, daysUntilRelease: 0 }),
      unit({ unitId: 'u8', gross: 800, daysUntilRelease: 0 }),
    ];
    const r = computeAnticipation(units, 900, RATE);
    expect(r.consumedUnitIds).toEqual(['u3', 'u8']); // ordem do grupo
    expect(r.consumedGross).toBe(1100);
    expect(r.realCost).toBe(0);
    expect(r.recommendedNet).toBe(1100);
    expect(r.receive).toBe(900);
    expect(r.effectiveFee).toBe(200);
  });

  it('cross-day: mistura pode ter MENOR gross que pegar só o dia barato grande', () => {
    // BIG=R$80 (5d) sozinho cobre R$50, mas gross 80. S1=R$30 (5d)+S2=R$30 (40d)
    // cobrem 50 com gross 60 → menor. O motor deve preferir {S1,S2}.
    const units = [
      unit({ unitId: 'BIG', gross: 8000, daysUntilRelease: 5 }),
      unit({ unitId: 'S1', gross: 3000, daysUntilRelease: 5 }),
      unit({ unitId: 'S2', gross: 3000, daysUntilRelease: 40 }),
    ];
    const r = computeAnticipation(units, 5000, RATE);
    expect(r.consumedUnitIds).toEqual(['S1', 'S2']);
    expect(r.consumedGross).toBe(6000);
    expect(r.effectiveFee).toBe(1000); // 6000 − 5000 (antes {BIG} dava 3000)
  });

  it('DP (n > 16): acha o mínimo exato quando a resolução não é escalada', () => {
    // 17 unidades de R$10 (0d, líq=gross) → força a DP (não a força bruta). Pede R$30
    // → mínimo exato = 3 unidades (gross 3000), recebe 3000.
    const units = Array.from({ length: 17 }, (_, i) =>
      unit({ unitId: `u${i}`, gross: 1000, daysUntilRelease: 0 }),
    );
    const r = computeAnticipation(units, 3000, RATE);
    expect(r.consumedGross).toBe(3000);
    expect(r.consumedUnitIds).toHaveLength(3);
    expect(r.receive).toBe(3000);
  });

  it('DP escalada (valor alto + muitas unidades): cobre o pedido sem subcobrir', () => {
    // 30 unidades de R$10.000 (0d). Pede R$155.000 → precisa de 16 (16×10k=160k ≥ 155k;
    // 15×10k=150k < 155k). Mesmo com a resolução escalada, nunca subcobre.
    const units = Array.from({ length: 30 }, (_, i) =>
      unit({ unitId: `u${i}`, gross: 1000000, daysUntilRelease: 0 }),
    );
    const r = computeAnticipation(units, 15500000, RATE);
    expect(r.consumedGross).toBe(16000000);
    expect(r.recommendedNet).toBeGreaterThanOrEqual(15500000);
    expect(r.receive).toBe(15500000);
  });
});
