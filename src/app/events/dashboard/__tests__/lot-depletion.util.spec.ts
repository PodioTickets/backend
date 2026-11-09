import { lotDepletionStatus } from '../lot-depletion.util';

describe('lotDepletionStatus', () => {
  it('até 30% é Normal (Saudável)', () => {
    expect(lotDepletionStatus(0, true)).toBe('Normal');
    expect(lotDepletionStatus(30, true)).toBe('Normal');
  });

  it('de 31% a 70% é Atenção', () => {
    expect(lotDepletionStatus(30.5, true)).toBe('Atenção');
    expect(lotDepletionStatus(70, true)).toBe('Atenção');
  });

  it('acima de 70% é Crítico só no último lote', () => {
    expect(lotDepletionStatus(71, true)).toBe('Crítico');
    expect(lotDepletionStatus(95, false)).toBe('Atenção');
  });
});
