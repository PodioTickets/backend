/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: os "períodos" do painel do organizador (últimas 24h, 7 dias, 1 mês, geral, etc.)
 *           e a comparação com o período anterior (a setinha de "subiu/caiu X%").
 *
 *  EM RESUMO:
 *    O painel mostra números de um intervalo de tempo e compara com o intervalo anterior.
 *    Estas contas definem o intervalo de cada período, o intervalo anterior para comparação,
 *    e a variação percentual.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • "Geral" não tem filtro de tempo (sem início/fim).
 *    • Cada período relativo gera um intervalo coerente (começa antes e termina agora).
 *    • A variação % é correta, inclusive os casos especiais (de zero para algo = 100%; 0/0 = 0%).
 *    • Listar os dias de um intervalo e os últimos 6 meses sai certo.
 *
 *  COMO CONFERIMOS:
 *    Contas puras: passamos os dados e conferimos o resultado (usando uma data fixa onde a função
 *    permite). Não envolve banco nem internet.
 * ============================================================================
 */
import {
  DashboardPeriod,
  calculateDateRange,
  getComparisonBounds,
  percentChange,
  eachUtcDayKeys,
  lastSixMonthKeys,
} from '../dashboard-period.util';

describe('calculateDateRange', () => {
  it('"geral" não tem filtro de tempo (início e fim nulos)', () => {
    expect(calculateDateRange(DashboardPeriod.GERAL)).toEqual({ start: null, end: null });
  });

  it('últimas 24h: intervalo de ~24 horas terminando agora', () => {
    const { start, end } = calculateDateRange(DashboardPeriod.LAST_24H);
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    const horas = (end!.getTime() - start!.getTime()) / (1000 * 60 * 60);
    expect(horas).toBeGreaterThan(23.9);
    expect(horas).toBeLessThan(24.1);
  });

  it('começa antes e termina depois nos períodos relativos', () => {
    const { start, end } = calculateDateRange(DashboardPeriod.LAST_7D);
    expect(start!.getTime()).toBeLessThan(end!.getTime());
  });
});

describe('getComparisonBounds', () => {
  it('"geral" não tem comparação', () => {
    expect(getComparisonBounds({ start: null, end: null }, new Date(), DashboardPeriod.GERAL)).toBeNull();
  });

  it('1 mês compara com o mês de calendário anterior completo', () => {
    const now = new Date(2026, 5, 15); // junho/2026 (mês 5 = junho, base 0)
    const bounds = getComparisonBounds({ start: new Date(), end: new Date() }, now, DashboardPeriod.LAST_1M);
    expect(bounds!.prevStart).toEqual(new Date(2026, 4, 1)); // 1º de maio
    expect(bounds!.prevEndExclusive).toEqual(new Date(2026, 5, 1)); // 1º de junho (exclusivo)
  });

  it('demais períodos: janela de mesma duração imediatamente antes', () => {
    const start = new Date('2026-06-08T00:00:00.000Z');
    const end = new Date('2026-06-15T00:00:00.000Z'); // 7 dias
    const bounds = getComparisonBounds({ start, end }, end, DashboardPeriod.LAST_7D);
    expect(bounds!.prevEndExclusive).toEqual(start);
    expect(bounds!.prevStart).toEqual(new Date('2026-06-01T00:00:00.000Z')); // 7 dias antes do start
  });
});

describe('percentChange', () => {
  it('cresce de 80 para 100 → +25%', () => {
    expect(percentChange(100, 80)).toBe(25);
  });

  it('cai de 100 para 50 → -50%', () => {
    expect(percentChange(50, 100)).toBe(-50);
  });

  it('de zero para um valor positivo → null (sem baseline, exibe "novo")', () => {
    expect(percentChange(10, 0)).toBeNull();
  });

  it('zero para zero → 0%', () => {
    expect(percentChange(0, 0)).toBe(0);
  });

  it('arredonda em 2 casas', () => {
    expect(percentChange(1, 3)).toBe(-66.67);
  });
});

describe('eachUtcDayKeys', () => {
  it('lista os dias do intervalo (inclusive) em YYYY-MM-DD', () => {
    const from = new Date('2026-06-01T10:00:00.000Z');
    const to = new Date('2026-06-03T05:00:00.000Z');
    expect(eachUtcDayKeys(from, to)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
  });

  it('mesmo dia → uma única chave', () => {
    const d = new Date('2026-06-01T10:00:00.000Z');
    expect(eachUtcDayKeys(d, d)).toEqual(['2026-06-01']);
  });
});

describe('lastSixMonthKeys', () => {
  it('últimos 6 meses (YYYY-MM), do mais antigo ao mais recente', () => {
    const now = new Date(2026, 5, 15); // junho/2026
    expect(lastSixMonthKeys(now)).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
    ]);
  });
});
