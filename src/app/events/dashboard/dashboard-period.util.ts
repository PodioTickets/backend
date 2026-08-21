import { brtDayStartUtcOfInstant } from '../../../common/utils/brt-date.util';

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
 * - LAST_24H ("Hoje"): DIA CIVIL de hoje em BRT (00:00 BRT → agora), NÃO as últimas
 *   24h rolantes — senão apareciam inscrições de ontem (janela cruzava a meia-noite).
 * - Demais: janela relativa ao agora.
 */
export function calculateDateRange(period: DashboardPeriod): DateRange {
  const now = new Date();
  const start = new Date();

  switch (period) {
    case DashboardPeriod.LAST_24H:
      // "Hoje" = a partir do início do dia em Brasília (não now-24h).
      return { start: brtDayStartUtcOfInstant(now), end: now };
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

  // "Hoje": compara com ONTEM até o MESMO horário (desloca a janela do dia em −24h,
  // que em BRT é determinístico — sem horário de verão). Evita comparar o dia parcial
  // de hoje contra o dia inteiro de ontem.
  if (period === DashboardPeriod.LAST_24H && dateRange.start && dateRange.end) {
    const DAY_MS = 24 * 60 * 60 * 1000;
    return {
      prevStart: new Date(dateRange.start.getTime() - DAY_MS),
      prevEndExclusive: new Date(dateRange.end.getTime() - DAY_MS),
    };
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

// BRT = UTC-3 FIXO (sem horário de verão desde 2019). Deslocar o instante em −3h
// e ler os campos UTC dá o wall-clock civil de Brasília de forma portável (não
// depende do fuso do processo/CI). Espelha `brt-date.util`.
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Chaves `YYYY-MM-DD` de cada DIA CIVIL DE BRASÍLIA no intervalo [from, to]
 * (inclusive). Diferente de `eachUtcDayKeys`: alinha as colunas do chart ao dia
 * BRT — o mesmo bucket usado pelo SQL (`AT TIME ZONE 'America/Sao_Paulo'`), então
 * "hoje" = dia civil de Brasília (recebe as vendas do dia) e só vira à meia-noite
 * BRT, não à meia-noite UTC (21h BRT). Cap em 500 dias contra range inválido.
 */
export function eachBrtDayKeys(from: Date, to: Date): string[] {
  const f = new Date(from.getTime() - BRT_OFFSET_MS);
  const tEnd = new Date(to.getTime() - BRT_OFFSET_MS);
  const keys: string[] = [];
  let t = Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate());
  const endT = Date.UTC(tEnd.getUTCFullYear(), tEnd.getUTCMonth(), tEnd.getUTCDate());
  while (t <= endT) {
    keys.push(new Date(t).toISOString().split('T')[0]);
    t += 24 * 60 * 60 * 1000;
    if (keys.length > 500) break;
  }
  return keys;
}

/**
 * Chaves `YYYY-MM-DD HH:00` de cada HORA do(s) dia(s) civil(is) de Brasília no
 * intervalo — do início (00:00) do dia BRT de `from` ao fim (23:00) do dia BRT de
 * `to`. Usado pelo período "Hoje" (LAST_24H) para o chart cobrir o dia INTEIRO por
 * hora (00h→23h) em vez de um único ponto diário. Casa com o bucket horário BRT do
 * SQL (`... 'YYYY-MM-DD HH24:00'`). Cap em 1000 horas contra range inválido.
 */
export function eachBrtHourKeys(from: Date, to: Date): string[] {
  const f = new Date(from.getTime() - BRT_OFFSET_MS);
  const tEnd = new Date(to.getTime() - BRT_OFFSET_MS);
  const keys: string[] = [];
  let t = Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate(), 0);
  const endT = Date.UTC(
    tEnd.getUTCFullYear(),
    tEnd.getUTCMonth(),
    tEnd.getUTCDate(),
    23,
  );
  while (t <= endT) {
    const d = new Date(t);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    keys.push(`${yyyy}-${mm}-${dd} ${hh}:00`);
    t += 60 * 60 * 1000;
    if (keys.length > 1000) break;
  }
  return keys;
}

/**
 * Últimos 6 meses calendário DE BRASÍLIA (chave `YYYY-MM`). Variante BRT de
 * `lastSixMonthKeys` — casa com o bucket mensal BRT do SQL no período `GERAL`.
 */
export function lastSixBrtMonthKeys(now: Date = new Date()): string[] {
  const b = new Date(now.getTime() - BRT_OFFSET_MS);
  const keys: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}
