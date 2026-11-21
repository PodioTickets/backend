import { lotDepletionStatus } from '../lot-depletion.util';

describe('lotDepletionStatus', () => {
  it('até 50% é Normal (Saudável)', () => {
    expect(lotDepletionStatus(0, true)).toBe('Normal');
    expect(lotDepletionStatus(50, true)).toBe('Normal');
  });

  it('acima de 50% até 80% é Atenção', () => {
    expect(lotDepletionStatus(50.5, true)).toBe('Atenção');
    expect(lotDepletionStatus(80, true)).toBe('Atenção');
  });

  it('acima de 80% é Crítico só no último lote', () => {
    expect(lotDepletionStatus(80.5, true)).toBe('Crítico');
    expect(lotDepletionStatus(100, true)).toBe('Crítico');
    expect(lotDepletionStatus(95, false)).toBe('Atenção');
  });
});
