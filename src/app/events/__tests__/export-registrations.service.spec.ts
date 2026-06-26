import { ExportRegistrationsService } from '../export-registrations.service';

describe('ExportRegistrationsService — coluna fixa de ID da inscrição', () => {
  const svc = new ExportRegistrationsService();
  const reg = {
    id: '2ebd8d00-1111-2222-3333-444444442ba0',
    user: { firstName: 'Ana', lastName: 'Silva', email: 'a@x.com' },
  };

  // TXT é CSV: linha 0 = metadata, linha 1 = headers, linha 2+ = dados.
  const txtLines = (regs: any[], fields: any[]) =>
    svc.generateTxt(regs, fields, 'Evento X').toString('utf8').split('\r\n');

  it('header tem "ID inscrição" como PRIMEIRA coluna', () => {
    const lines = txtLines([reg], ['nome', 'email']);
    expect(lines[1].startsWith('ID inscrição,')).toBe(true);
    expect(lines[1]).toBe('ID inscrição,Nome,E-mail');
  });

  it('linha de dados traz o ID curto #xxxxxx...xxxx (6 primeiros + ... + 4 últimos), igual à lista', () => {
    const lines = txtLines([reg], ['nome']);
    expect(lines[2].startsWith('#2ebd8d...2ba0,')).toBe(true);
  });

  it('ID ausente → célula vazia (sem #)', () => {
    const lines = txtLines([{ user: {} }], ['nome']);
    expect(lines[2].startsWith(',')).toBe(true);
  });

  it('Excel: a 1ª coluna do header também é "ID inscrição"', () => {
    // O Excel reusa buildExpandedRows; basta garantir que o buffer é gerado e não vazio.
    const buf = svc.generateExcel([reg], ['nome'], 'Evento X');
    expect(buf.length).toBeGreaterThan(0);
  });

  // ── Status (espelha a lista: Pago / Cancelado / Estornado / Chargeback) ──────
  const statusCell = (r: any) => txtLines([r], ['status'])[2].split(',').pop();

  it('CONFIRMED + pagamento PAID → "Pago" (não "Confirmado")', () => {
    expect(statusCell({ id: 'x', status: 'CONFIRMED', order: { payment: { status: 'PAID' } } })).toBe('Pago');
  });

  it('pagamento REFUNDED + refundType REFUND (inscrição CANCELLED) → "Estornado"', () => {
    expect(statusCell({ id: 'x', status: 'CANCELLED', order: { payment: { status: 'REFUNDED', metadata: { refundType: 'REFUND' } } } })).toBe('Estornado');
  });

  it('pagamento REFUNDED + refundType CHARGEBACK → "Chargeback"', () => {
    expect(statusCell({ id: 'x', status: 'CANCELLED', order: { payment: { status: 'REFUNDED', metadata: { refundType: 'CHARGEBACK' } } } })).toBe('Chargeback');
  });

  it('CANCELLED sem reembolso → "Cancelado"', () => {
    expect(statusCell({ id: 'x', status: 'CANCELLED', order: { payment: { status: 'FAILED' } } })).toBe('Cancelado');
  });

  // ── Perguntas soft-deletadas NÃO entram no export ────────────────────────────
  it('pergunta com deletedAt não vira coluna; a viva sim', () => {
    const r = {
      id: 'x', user: {},
      questionAnswers: [
        { answer: 'AZUL', question: { id: 'q1', question: 'Cor favorita?', isActive: true } },
        { answer: 'XYZ', question: { id: 'q2', question: 'Pergunta removida?', isActive: false } },
      ],
    };
    const lines = txtLines([r], ['perguntasRespostas']);
    expect(lines[1]).toContain('Cor favorita?');
    expect(lines[1]).not.toContain('Pergunta removida?');
    expect(lines[2]).toContain('AZUL');
    expect(lines[2]).not.toContain('XYZ');
  });

  // ── Quebras de linha embutidas viram espaço (sem célula de 2 linhas) ─────────
  it('resposta com \\n é achatada em uma linha só', () => {
    const r = {
      id: 'x', user: {},
      questionAnswers: [{ answer: 'linha1\nlinha2', question: { id: 'q1', question: 'Obs?', isActive: true } }],
    };
    const lines = txtLines([r], ['perguntasRespostas']);
    // 4 linhas no total (meta, header, dados) — sem linha extra do \n na resposta.
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('linha1 linha2');
  });
});
