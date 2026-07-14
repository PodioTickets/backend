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

  it('linha de dados traz o ID curto #<1º segmento do UUID>, igual aos painéis/telas', () => {
    const lines = txtLines([reg], ['nome']);
    expect(lines[2].startsWith('#2ebd8d00,')).toBe(true);
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

  it('pedido GRATUITO cancelado (CANCELLED + pagamento PAID) → "Cancelado", não "Pago"', () => {
    // Cancelar pedido grátis mantém Payment.status=PAID; o estado terminal da
    // inscrição deve prevalecer sobre o pagamento.
    expect(statusCell({ id: 'x', status: 'CANCELLED', order: { payment: { status: 'PAID' } } })).toBe('Cancelado');
  });

  // ── Forma de pagamento (pedido gratuito não exibe o método do gateway) ───────
  const metodoCell = (r: any) => txtLines([r], ['formaPagamento'])[2].split(',').pop();

  it('forma de pagamento: PIX em pedido pago → "Pix"', () => {
    expect(metodoCell({ id: 'x', order: { finalAmount: 5000, payment: { method: 'PIX' } } })).toBe('Pix');
  });

  it('forma de pagamento: pedido GRATUITO (finalAmount 0) → "Gratuito" mesmo com method PIX', () => {
    expect(metodoCell({ id: 'x', order: { finalAmount: 0, payment: { method: 'PIX' } } })).toBe('Gratuito');
  });

  // ── Data da compra: BRT (America/Sao_Paulo) COM hora, igual ao modal ─────────
  const dataCompraCell = (r: any) => txtLines([r], ['dataPagamento'])[2].split(',').pop();

  it('data da compra: instante em BRT com hora, igual ao organizador (não UTC/servidor)', () => {
    // 2026-06-15T01:00:00Z = 14/06 às 22:00 em Brasília (UTC-3). O dia BRT (14) difere
    // do dia UTC (15) — prova que formatamos no fuso certo, com horário.
    expect(dataCompraCell({ id: 'x', order: { purchaseDate: '2026-06-15T01:00:00.000Z' } }))
      .toBe('14/06/2026 - 22:00');
  });

  it('data da compra: ausente → célula vazia', () => {
    expect(dataCompraCell({ id: 'x', order: {} })).toBe('');
  });

  // ── Produto/variação: usa a variação ESCOLHIDA (variationName mapeado) ───────
  const produtosCell = (r: any) => txtLines([r], ['produtosEscolhidos'])[2].split(',').pop();

  it('produtos: renderiza "Produto (Variação)" a partir do variationName mapeado', () => {
    // O map de getRegistrationsForExport resolve variationName com a relação VIVA
    // (variação atual, pós-troca); aqui validamos o render do valor já resolvido.
    expect(produtosCell({ id: 'x', products: [{ product: { name: 'Camiseta' }, variationName: 'G' }] }))
      .toBe('Camiseta (G)');
  });

  it('produtos: opt-out "Sem interesse" NÃO aparece no export', () => {
    const r = {
      id: 'x',
      products: [
        { product: { name: 'Kit Corrida' }, variationName: 'Sem interesse' },
        { product: { name: 'Camiseta' }, variationName: 'G' },
      ],
    };
    // Só a Camiseta entra; o opt-out é omitido.
    expect(produtosCell(r)).toBe('Camiseta (G)');
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

  // ── Resposta em array JSON é formatada (não sai crua com colchetes/aspas) ────
  it('resposta única em array JSON → valor limpo (sem colchetes/aspas)', () => {
    const r = {
      id: 'x', user: {},
      questionAnswers: [{ answer: '["Teste aqui"]', question: { id: 'q1', question: 'Obs?', isActive: true } }],
    };
    const lines = txtLines([r], ['perguntasRespostas']);
    expect(lines[2]).toContain('Teste aqui');
    expect(lines[2]).not.toContain('[');
    expect(lines[2]).not.toContain('"Teste');
  });

  it('resposta de múltipla escolha (array JSON) → valores separados por vírgula', () => {
    const r = {
      id: 'x', user: {},
      questionAnswers: [{ answer: '["Sim","Talvez"]', question: { id: 'q1', question: 'Quais?', isActive: true } }],
    };
    const lines = txtLines([r], ['perguntasRespostas']);
    expect(lines[2]).toContain('Sim, Talvez');
    expect(lines[2]).not.toContain('[');
  });

  it('resposta de texto cru (não-JSON) passa direto', () => {
    const r = {
      id: 'x', user: {},
      questionAnswers: [{ answer: 'AZUL', question: { id: 'q1', question: 'Cor?', isActive: true } }],
    };
    const lines = txtLines([r], ['perguntasRespostas']);
    expect(lines[2]).toContain('AZUL');
  });

  // ── Campo "Ingresso": lê de tickets[] (plural) e AGREGA ──────────────────────
  // Regressão: o código lia `reg.ticket` (singular), que o include nunca traz →
  // a coluna saía vazia. Agora lê `reg.tickets[].ticket` e junta múltiplos.
  it('ingresso: "Categoria - Ingresso" a partir de tickets[]', () => {
    const r = { id: 'x', user: {}, tickets: [{ ticket: { name: 'Lote 1', category: { name: '5km' } } }] };
    expect(txtLines([r], ['ingresso'])[2].split(',').pop()).toBe('5km - Lote 1');
  });

  it('ingresso: sem categoria → só o nome do ingresso', () => {
    const r = { id: 'x', user: {}, tickets: [{ ticket: { name: 'Lote 1' } }] };
    expect(txtLines([r], ['ingresso'])[2].split(',').pop()).toBe('Lote 1');
  });

  it('ingresso: múltiplos ingressos da inscrição → agregados com "; "', () => {
    const r = {
      id: 'x', user: {},
      tickets: [
        { ticket: { name: 'Lote 1', category: { name: '5km' } } },
        { ticket: { name: 'Lote 2', category: { name: '10km' } } },
      ],
    };
    expect(txtLines([r], ['ingresso'])[2].split(',').pop()).toBe('5km - Lote 1; 10km - Lote 2');
  });

  it('ingresso: sem tickets → célula vazia', () => {
    expect(txtLines([{ id: 'x', user: {} }], ['ingresso'])[2].split(',').pop()).toBe('');
  });

  it('ingresso: shape antigo `reg.ticket` (singular) NÃO é mais lido → vazio', () => {
    expect(txtLines([{ id: 'x', user: {}, ticket: { name: 'Antigo' } }], ['ingresso'])[2].split(',').pop()).toBe('');
  });

  it('ingresso: PREFERE o snapshot sobre a relação viva (ingresso renomeado)', () => {
    const r = {
      id: 'x', user: {},
      tickets: [{
        ticketSnapshot: { name: 'Comprado', category: { name: '5km' } },
        ticket: { name: 'Renomeado', category: { name: '10km' } },
      }],
    };
    expect(txtLines([r], ['ingresso'])[2].split(',').pop()).toBe('5km - Comprado');
  });

  it('ingresso: snapshot SEM relação viva (ingresso deletado) ainda exporta', () => {
    const r = { id: 'x', user: {}, tickets: [{ ticketSnapshot: { name: 'Lote 1', category: { name: '5km' } }, ticket: null }] };
    expect(txtLines([r], ['ingresso'])[2].split(',').pop()).toBe('5km - Lote 1');
  });

  // ── Campo "Modalidade": modality do ingresso, agregado + dedup ────────────────
  it('modalidade: lê ticket.modality (label) da relação viva', () => {
    const r = { id: 'x', user: {}, tickets: [{ ticket: { name: 'Lote 1', modality: 'Corrida' } }] };
    expect(txtLines([r], ['modalidade'])[2].split(',').pop()).toBe('Corrida');
  });

  it('modalidade: PREFERE o snapshot sobre a relação viva', () => {
    const r = {
      id: 'x', user: {},
      tickets: [{ ticketSnapshot: { modality: 'Caminhada' }, ticket: { modality: 'Corrida' } }],
    };
    expect(txtLines([r], ['modalidade'])[2].split(',').pop()).toBe('Caminhada');
  });

  it('modalidade: múltiplos ingressos com a MESMA modalidade → sem repetição', () => {
    const r = {
      id: 'x', user: {},
      tickets: [{ ticket: { modality: 'Corrida' } }, { ticket: { modality: 'Corrida' } }],
    };
    expect(txtLines([r], ['modalidade'])[2].split(',').pop()).toBe('Corrida');
  });

  it('modalidade: modalidades distintas → agregadas com "; "', () => {
    const r = {
      id: 'x', user: {},
      tickets: [{ ticket: { modality: 'Corrida' } }, { ticket: { modality: 'Caminhada' } }],
    };
    expect(txtLines([r], ['modalidade'])[2].split(',').pop()).toBe('Corrida; Caminhada');
  });

  it('modalidade: ingresso sem modalidade → célula vazia', () => {
    const r = { id: 'x', user: {}, tickets: [{ ticket: { name: 'Lote 1' } }] };
    expect(txtLines([r], ['modalidade'])[2].split(',').pop()).toBe('');
  });
});
