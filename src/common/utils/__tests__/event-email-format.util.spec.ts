import {
  formatBrtInstant,
  formatEventHappensDate,
  formatEventCardAddress,
  formatEventDateWithWeekday,
} from '../event-email-format.util';

describe('formatEventHappensDate — data do card do e-mail (igual ao card do app)', () => {
  it('sexta-feira → "Sexta-feira, 31 de julho" (1ª maiúscula, sem ano, UTC)', () => {
    expect(formatEventHappensDate('2026-07-31T12:00:00.000Z')).toBe(
      'Sexta-feira, 31 de julho',
    );
  });

  it('dia da semana com a 1ª letra maiúscula (igual ao card do app)', () => {
    expect(formatEventHappensDate('2026-08-29T12:00:00.000Z')).toBe(
      'Sábado, 29 de agosto',
    );
    expect(formatEventHappensDate('2026-08-30T12:00:00.000Z')).toBe(
      'Domingo, 30 de agosto',
    );
  });

  it('UTC: não desloca pelo fuso do servidor (wall-clock do evento)', () => {
    // 23:30Z de 31/07 continua 31/07 (não vira 01/08 nem muda o dia da semana).
    expect(formatEventHappensDate('2026-07-31T23:30:00.000Z')).toBe(
      'Sexta-feira, 31 de julho',
    );
  });

  it('data ausente/ inválida → ""', () => {
    expect(formatEventHappensDate(null)).toBe('');
    expect(formatEventHappensDate(undefined)).toBe('');
    expect(formatEventHappensDate('não é data')).toBe('');
  });
});

describe('formatEventCardAddress — endereço do card (local, cidade, estado)', () => {
  it('junta locationName, city, state', () => {
    expect(
      formatEventCardAddress({ locationName: 'Ginásio Municipal', city: 'São Paulo', state: 'SP' }),
    ).toBe('Ginásio Municipal, São Paulo, SP');
  });

  it('sem locationName (evento legado) → "Cidade, Estado"', () => {
    expect(formatEventCardAddress({ city: 'Campinas', state: 'SP' })).toBe(
      'Campinas, SP',
    );
  });

  it('omite campos vazios e apara espaços', () => {
    expect(
      formatEventCardAddress({ locationName: '  Arena  ', city: '', state: 'RJ' }),
    ).toBe('Arena, RJ');
  });
});

describe('formatEventDateWithWeekday — data do evento nos e-mails de auditoria', () => {
  it('formata "25/07/2026 · sábado" lendo em UTC (eventDate é wall-clock)', () => {
    expect(formatEventDateWithWeekday('2026-07-25T00:00:00.000Z')).toBe(
      '25/07/2026 · sábado',
    );
  });

  it('meia-noite não recua um dia (regressão do fuso do servidor)', () => {
    // Com getters locais num servidor a oeste de UTC, 00:00Z viraria dia 24.
    expect(formatEventDateWithWeekday('2026-07-25T00:00:00.000Z')).toContain(
      '25/07/2026',
    );
  });

  it('data ausente ou inválida vira ""', () => {
    expect(formatEventDateWithWeekday(null)).toBe('');
    expect(formatEventDateWithWeekday('nao-e-data')).toBe('');
  });
});

describe('formatBrtInstant — "analisado em" / "enviado em" no fuso de Brasília', () => {
  it('02:30Z vira 23h30 do dia ANTERIOR (UTC-3)', () => {
    // O bug reportado: em produção o servidor roda em UTC, então getHours()
    // cravava 02h30 do dia 03 em vez de 23h30 do dia 02.
    expect(formatBrtInstant(new Date('2026-09-03T02:30:00.000Z'))).toBe(
      '02/09/2026 · 23h30',
    );
  });

  it('meio-dia UTC vira 09h00 BRT, mesmo dia', () => {
    expect(formatBrtInstant(new Date('2026-09-03T12:00:00.000Z'))).toBe(
      '03/09/2026 · 09h00',
    );
  });

  it('zero-padding na hora e no minuto', () => {
    expect(formatBrtInstant(new Date('2026-09-03T11:05:00.000Z'))).toBe(
      '03/09/2026 · 08h05',
    );
  });

  it('não depende do fuso da máquina que roda o teste', () => {
    // Formatação explícita por timeZone: o resultado é o mesmo em UTC ou BRT.
    const instant = new Date('2026-01-15T18:45:00.000Z');
    expect(formatBrtInstant(instant)).toBe('15/01/2026 · 15h45');
  });
});
