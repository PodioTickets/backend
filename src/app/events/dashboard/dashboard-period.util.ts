/**
 * Períodos suportados pelo dashboard (mesmo enum legacy mantido pra não quebrar
 * o front que já manda `?period=...`).
 */
export enum DashboardPeriod {
  GERAL = 'geral',
  LAST_24H = '24h',
  LAST_7D = '7d',
  LAST_15D = '15d',
  LAST_1M = '1m',
  LAST_2M = '2m',
}

export interface DateRange {
  start: Date | null;
  end: Date | null;
}

export interface ComparisonBounds {
  prevStart: Date;
  prevEndExclusive: Date;
}

/**
 * Range absoluto do período atual.
 * - GERAL: { start: null, end: null } — sem filtro temporal.
 * - Demais: janela relativa ao agora.
 */
export function calculateDateRange(period: DashboardPeriod): DateRange {
  const now = new Date();
  const start = new Date();

  switch (period) {
    case DashboardPeriod.LAST_24H:
      start.setHours(now.getHours() - 24);
      return { start, end: now };
    case DashboardPeriod.LAST_7D:
      start.setDate(now.getDate() - 7);
      return { start, end: now };
    case DashboardPeriod.LAST_15D:
      start.setDate(now.getDate() - 15);
      return { start, end: now };
    case DashboardPeriod.LAST_1M:
      start.setMonth(now.getMonth() - 1);
      return { start, end: now };
    case DashboardPeriod.LAST_2M:
      start.setMonth(now.getMonth() - 2);
      return { start, end: now };
    case DashboardPeriod.GERAL:
    default:
      return { start: null, end: null };
  }
}

/**
 * Intervalo do período anterior pra cálculo de variação %.
 * - GERAL: sem comparação (retorna null).
 * - LAST_1M: mês calendário anterior completo.
 * - Demais: janela de mesma duração imediatamente antes do período atual.
 */
export function getComparisonBounds(
  dateRange: DateRange,
  now: Date,
  period: DashboardPeriod,
): ComparisonBounds | null {
  if (period === DashboardPeriod.GERAL) return null;

  if (period === DashboardPeriod.LAST_1M) {
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevEndExclusive = new Date(now.getFullYear(), now.getMonth(), 1);
    return { prevStart, prevEndExclusive };
  }

  if (dateRange.start && dateRange.end) {
    const durationMs = dateRange.end.getTime() - dateRange.start.getTime();
    const prevStart = new Date(dateRange.start.getTime() - durationMs);
    const prevEndExclusive = new Date(dateRange.start.getTime());
    return { prevStart, prevEndExclusive };
  }

  return null;
}

/**
 * Variação % vs período de referência: (atual − anterior) / anterior × 100.
 * - 0/0 → 0 (nada antes, nada agora: sem variação).
 * - anterior 0 e atual > 0 → `null` (SEM BASELINE): a variação é matematicamente
 *   indefinida (divisão por zero). Antes retornávamos `100` fixo, o que exibia um
 *   "+100% vs ontem" ENGANOSO independentemente do valor atual. `null` sinaliza ao
 *   front pra exibir "novo" em vez de um percentual inventado.
 * - Arredonda em 2 casas.
 */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0 && current === 0) return 0;
  if (previous === 0) return current > 0 ? null : 0;
  const raw = ((current - previous) / previous) * 100;
  return Math.round(raw * 100) / 100;
}

/**
 * Chaves UTC `YYYY-MM-DD` de cada dia no intervalo [from, to] (inclusive).
 * Cap em 500 dias contra range inválido.
 */
export function eachUtcDayKeys(from: Date, to: Date): string[] {
  const keys: string[] = [];
  let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const endT = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (t <= endT) {
    keys.push(new Date(t).toISOString().split('T')[0]);
    t += 24 * 60 * 60 * 1000;
    if (keys.length > 500) break;
  }
  return keys;
}

/**
 * Últimos 6 meses calendário (chave `YYYY-MM`), do mais antigo pro mais recente.
 * Usado pelo chart no período `GERAL`.
 */
export function lastSixMonthKeys(now: Date = new Date()): string[] {
  const keys: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}
