import {
  formatEventHappensDate,
  formatEventCardAddress,
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
