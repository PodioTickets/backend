/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: tratamento do número do documento do participante — CPF (brasileiro)
 *           ou passaporte (estrangeiro).
 *
 *  EM RESUMO:
 *    O sistema precisa "limpar" e entender o documento de quem se inscreve. CPF é só
 *    números; passaporte pode ter letras (e elas são parte do número, não dá para jogar
 *    fora). Isso é usado em buscas, em evitar cadastro duplicado e em cupons restritos a
 *    certos documentos.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • CPF: tira pontuação e fica só com os números.
 *    • Passaporte: deixa em maiúsculas e remove só o que não é letra/número (mantém as letras).
 *    • Quando não dizem o tipo, trata como CPF (comportamento antigo do Brasil).
 *    • Adivinhar o tipo: 11 números = CPF; tem letra = passaporte.
 *    • Montar a lista de documentos de um cupom a partir do que o painel enviou (novo ou antigo).
 *    • Dizer se o documento de uma pessoa está na lista permitida do cupom.
 *
 *  COMO CONFERIMOS:
 *    Passamos vários documentos e conferimos o resultado. É uma conta pura: não envolve
 *    banco de dados nem internet — roda 100% real.
 * ============================================================================
 */
import { DocumentType } from '@prisma/client';
import {
  cleanDocumentNumber,
  inferDocumentType,
  buildDocumentList,
  isDocumentInList,
  resolveDocument,
} from '../document.util';

describe('cleanDocumentNumber', () => {
  it('CPF: remove pontuação e mantém só os números', () => {
    expect(cleanDocumentNumber('123.456.789-00', DocumentType.CPF)).toBe('12345678900');
  });

  it('sem tipo informado, trata como CPF (só números)', () => {
    expect(cleanDocumentNumber('123.456.789-00', null)).toBe('12345678900');
  });

  it('passaporte: maiúsculas e mantém letras+números (remove o resto)', () => {
    expect(cleanDocumentNumber('ab-12 34/cd', DocumentType.PASSPORT)).toBe('AB1234CD');
  });

  it('vazio ou nulo vira string vazia', () => {
    expect(cleanDocumentNumber('', DocumentType.CPF)).toBe('');
    expect(cleanDocumentNumber(null, DocumentType.CPF)).toBe('');
    expect(cleanDocumentNumber('   ', DocumentType.CPF)).toBe('');
  });
});

describe('inferDocumentType', () => {
  it('11 números = CPF', () => {
    expect(inferDocumentType('123.456.789-00')).toBe(DocumentType.CPF);
  });

  it('tem letra = passaporte', () => {
    expect(inferDocumentType('AB123456')).toBe(DocumentType.PASSPORT);
  });

  it('só números mas não 11 = passaporte', () => {
    expect(inferDocumentType('12345')).toBe(DocumentType.PASSPORT);
  });

  it('vazio = CPF (default conservador)', () => {
    expect(inferDocumentType(null)).toBe(DocumentType.CPF);
  });
});

describe('buildDocumentList', () => {
  it('usa a lista nova (documentList) quando vem preenchida e normaliza', () => {
    const out = buildDocumentList({
      documentList: [{ type: DocumentType.CPF, numberClean: '123.456.789-00' }],
    });
    expect(out).toEqual([{ type: DocumentType.CPF, numberClean: '12345678900' }]);
  });

  it('cai para a lista antiga (cpfList) quando só ela vem', () => {
    const out = buildDocumentList({ cpfList: ['111.111.111-11'] });
    expect(out).toEqual([{ type: DocumentType.CPF, numberClean: '11111111111' }]);
  });

  it('lista nova tem prioridade sobre a antiga', () => {
    const out = buildDocumentList({
      documentList: [{ type: DocumentType.PASSPORT, numberClean: 'AB12' }],
      cpfList: ['111.111.111-11'],
    });
    expect(out).toEqual([{ type: DocumentType.PASSPORT, numberClean: 'AB12' }]);
  });

  it('descarta itens que ficam vazios após limpar', () => {
    const out = buildDocumentList({
      documentList: [
        { type: DocumentType.CPF, numberClean: '...' },
        { type: DocumentType.CPF, numberClean: '222' },
      ],
    });
    expect(out).toEqual([{ type: DocumentType.CPF, numberClean: '222' }]);
  });

  it('ambas vazias = null', () => {
    expect(buildDocumentList({})).toBeNull();
    expect(buildDocumentList({ documentList: [], cpfList: [] })).toBeNull();
  });
});

describe('isDocumentInList', () => {
  it('encontra na lista nova quando tipo e número batem', () => {
    const user = { documentType: DocumentType.CPF, documentNumberClean: '12345678900' };
    const list = [{ type: DocumentType.CPF, numberClean: '12345678900' }];
    expect(isDocumentInList(user, list, null)).toBe(true);
  });

  it('não encontra quando o tipo difere (CPF x passaporte com mesmo número)', () => {
    const user = { documentType: DocumentType.PASSPORT, documentNumberClean: '12345678900' };
    const list = [{ type: DocumentType.CPF, numberClean: '12345678900' }];
    expect(isDocumentInList(user, list, null)).toBe(false);
  });

  it('usa a lista antiga (cpfList) só para usuários CPF', () => {
    const cpfUser = { documentType: DocumentType.CPF, documentNumberClean: '11111111111' };
    expect(isDocumentInList(cpfUser, null, ['111.111.111-11'])).toBe(true);

    const passUser = { documentType: DocumentType.PASSPORT, documentNumberClean: '11111111111' };
    expect(isDocumentInList(passUser, null, ['111.111.111-11'])).toBe(false);
  });

  it('usuário sem documento cadastrado nunca dá match', () => {
    expect(isDocumentInList({ documentNumberClean: null }, [{ type: 'CPF', numberClean: 'x' }], null)).toBe(false);
  });
});

describe('resolveDocument', () => {
  it('prioriza documentNumber sobre cpf e infere o tipo', () => {
    expect(resolveDocument({ documentNumber: 'AB123' })).toEqual({
      type: DocumentType.PASSPORT,
      number: 'AB123',
      clean: 'AB123',
    });
  });

  it('usa cpf quando não há documentNumber; número e clean são iguais', () => {
    expect(resolveDocument({ cpf: '123.456.789-00' })).toEqual({
      type: DocumentType.CPF,
      number: '12345678900',
      clean: '12345678900',
    });
  });

  it('respeita o tipo informado explicitamente', () => {
    const r = resolveDocument({ documentType: DocumentType.PASSPORT, documentNumber: '12345678900' });
    expect(r.type).toBe(DocumentType.PASSPORT);
  });

  it('entrada vazia devolve tudo nulo/vazio', () => {
    expect(resolveDocument({})).toEqual({ type: null, number: '', clean: '' });
  });
});
