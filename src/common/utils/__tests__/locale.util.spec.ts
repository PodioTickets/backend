/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: regras de nacionalidade e formatação para participantes do Brasil e do exterior.
 *
 *  EM RESUMO:
 *    O sistema precisa descobrir o país da pessoa (a partir do nome do país ou do código),
 *    saber se ela é brasileira, e formatar telefone e CPF do jeito certo. Brasileiro tem
 *    CPF e máscara própria; estrangeiro tem passaporte e o documento fica como veio.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Entende o país escrito de várias formas ("Brasil", "BR", "BRA", "Argentina").
 *    • Reconhece brasileiro x estrangeiro (passaporte/letras no documento = estrangeiro).
 *    • Formata CPF brasileiro (000.000.000-00) e deixa documento estrangeiro como está.
 *    • Mostra o rótulo certo do campo: "CPF" para brasileiro, "Documento" para estrangeiro.
 *
 *  COMO CONFERIMOS:
 *    Passamos países, documentos e telefones e conferimos o resultado. Conta pura, sem banco
 *    nem internet — usa as mesmas bibliotecas de país/telefone que rodam em produção.
 * ============================================================================
 */
import {
  getISOFromCountry,
  isBrazilian,
  formatCpfByCountry,
  documentLabelByCountry,
} from '../locale.util';

describe('getISOFromCountry', () => {
  it('entende o nome em português ("Brasil" → BR)', () => {
    expect(getISOFromCountry('Brasil')).toBe('BR');
  });

  it('entende o código de 2 letras ("AR")', () => {
    expect(getISOFromCountry('AR')).toBe('AR');
  });

  it('entende o código de 3 letras ("USA" → US)', () => {
    expect(getISOFromCountry('USA')).toBe('US');
  });

  it('país vazio devolve nulo (não assume Brasil)', () => {
    expect(getISOFromCountry(null)).toBeNull();
    expect(getISOFromCountry('')).toBeNull();
  });
});

describe('isBrazilian', () => {
  it('passaporte explícito = estrangeiro', () => {
    expect(isBrazilian('Brasil', 'PASSPORT', '12345678900')).toBe(false);
  });

  it('documento com letras = estrangeiro', () => {
    expect(isBrazilian(null, null, 'AB123456')).toBe(false);
  });

  it('país Brasil = brasileiro', () => {
    expect(isBrazilian('Brasil', 'CPF', '12345678900')).toBe(true);
  });

  it('país estrangeiro = não brasileiro', () => {
    expect(isBrazilian('Argentina', null, '12345678')).toBe(false);
  });

  it('sem país, documento só números e tipo CPF → assume brasileiro', () => {
    expect(isBrazilian(null, 'CPF', '12345678900')).toBe(true);
  });
});

describe('formatCpfByCountry', () => {
  it('formata CPF brasileiro com máscara', () => {
    expect(formatCpfByCountry('12345678900', 'Brasil', 'CPF')).toBe('123.456.789-00');
  });

  it('documento estrangeiro fica como veio (sem máscara)', () => {
    expect(formatCpfByCountry('AB123456', 'Argentina', 'PASSPORT')).toBe('AB123456');
  });

  it('número que não tem 11 dígitos fica como veio', () => {
    expect(formatCpfByCountry('123', 'Brasil', 'CPF')).toBe('123');
  });

  it('vazio devolve vazio', () => {
    expect(formatCpfByCountry('', 'Brasil', 'CPF')).toBe('');
  });
});

describe('documentLabelByCountry', () => {
  it('"CPF" para brasileiro', () => {
    expect(documentLabelByCountry('Brasil', 'CPF', '12345678900')).toBe('CPF');
  });

  it('"Documento" para estrangeiro', () => {
    expect(documentLabelByCountry('Argentina', 'PASSPORT', 'AB123')).toBe('Documento');
  });
});
