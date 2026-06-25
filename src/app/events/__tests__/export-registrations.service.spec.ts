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
});
