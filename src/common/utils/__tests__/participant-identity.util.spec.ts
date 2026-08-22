/**
 * ROTEIRO — identidade do participante (presente vs. próprio comprador)
 * =====================================================================
 * Reproduz o BUG relatado: comprar pra SI MESMO trocando SÓ o e-mail (mesmo CPF) ia
 * como PRESENTE. A causa era a comparação depender do lookup global por documento, que
 * falha em contas legadas SEM `documentNumberClean`. `decideParticipantIdentity` usa o
 * documento do COMPRADOR (com fallback de normalização via `resolveBuyerDocument`) como
 * identidade canônica → mesmo documento = mesma pessoa = NÃO é presente.
 */
import { DocumentType } from '@prisma/client';
import {
  decideParticipantIdentity,
  isSameNaturalPerson,
  resolveBuyerDocument,
} from '../participant-identity.util';

const BUYER = 'buyer-123';
const OTHER = 'other-456';

describe('decideParticipantIdentity', () => {
  it('mesmo e-mail do comprador → próprio comprador, sem presente, sem snapshot', () => {
    const r = decideParticipantIdentity({
      participantEmail: 'Buyer@Mail.com',
      participantDocClean: '11122233344',
      participantDocType: DocumentType.CPF,
      buyer: { userId: BUYER, email: 'buyer@mail.com', docClean: '11122233344', docType: DocumentType.CPF },
      matchedUserId: null,
    });
    expect(r).toEqual({ participantUserId: BUYER, isGift: false, needsSnapshot: false });
  });

  // ─── O BUG: e-mail diferente, MESMO CPF, conta legada sem clean (matched null) ───
  it('e-mail diferente + MESMO documento + matched null (conta legada) → NÃO é presente', () => {
    const r = decideParticipantIdentity({
      participantEmail: 'novo-email@mail.com',
      participantDocClean: '11122233344',
      participantDocType: DocumentType.CPF,
      buyer: { userId: BUYER, email: 'buyer@mail.com', docClean: '11122233344', docType: DocumentType.CPF },
      matchedUserId: null, // lookup global falhou (conta do comprador sem documentNumberClean)
    });
    expect(r.isGift).toBe(false);
    expect(r.participantUserId).toBe(BUYER);
    expect(r.needsSnapshot).toBe(true); // e-mail difere → grava snapshot do e-mail digitado
  });

  it('e-mail diferente + MESMO documento + matched = próprio comprador → NÃO é presente', () => {
    const r = decideParticipantIdentity({
      participantEmail: 'novo-email@mail.com',
      participantDocClean: '11122233344',
      participantDocType: DocumentType.CPF,
      buyer: { userId: BUYER, email: 'buyer@mail.com', docClean: '11122233344', docType: DocumentType.CPF },
      matchedUserId: BUYER,
    });
    expect(r.isGift).toBe(false);
    expect(r.participantUserId).toBe(BUYER);
  });

  it('e-mail diferente + documento DIFERENTE + conta encontrada → PRESENTE p/ essa conta', () => {
    const r = decideParticipantIdentity({
      participantEmail: 'amigo@mail.com',
      participantDocClean: '99988877766',
      participantDocType: DocumentType.CPF,
      buyer: { userId: BUYER, email: 'buyer@mail.com', docClean: '11122233344', docType: DocumentType.CPF },
      matchedUserId: OTHER,
    });
    expect(r.isGift).toBe(true);
    expect(r.participantUserId).toBe(OTHER);
  });

  it('e-mail diferente + documento DIFERENTE + sem conta → PRESENTE (guest)', () => {
    const r = decideParticipantIdentity({
      participantEmail: 'amigo@mail.com',
      participantDocClean: '99988877766',
      participantDocType: DocumentType.CPF,
      buyer: { userId: BUYER, email: 'buyer@mail.com', docClean: '11122233344', docType: DocumentType.CPF },
      matchedUserId: null,
    });
    expect(r.isGift).toBe(true);
    expect(r.participantUserId).toBeNull();
  });

  it('mesmo NÚMERO mas TIPO diferente (CPF×passaporte) → pessoas distintas → presente', () => {
    const r = decideParticipantIdentity({
      participantEmail: 'x@mail.com',
      participantDocClean: '11122233344',
      participantDocType: DocumentType.PASSPORT,
      buyer: { userId: BUYER, email: 'buyer@mail.com', docClean: '11122233344', docType: DocumentType.CPF },
      matchedUserId: null,
    });
    expect(r.isGift).toBe(true);
    expect(r.participantUserId).toBeNull();
  });

  it('comprador SEM documento (docClean vazio) + participante com doc → não casa por doc', () => {
    const r = decideParticipantIdentity({
      participantEmail: 'x@mail.com',
      participantDocClean: '11122233344',
      participantDocType: DocumentType.CPF,
      buyer: { userId: BUYER, email: 'buyer@mail.com', docClean: '', docType: null },
      matchedUserId: null,
    });
    // Sem documento do comprador não dá pra afirmar que é ele → cai na regra do lookup (guest).
    expect(r.isGift).toBe(true);
  });

  it('documento do participante vazio + matched null → guest (presente)', () => {
    const r = decideParticipantIdentity({
      participantEmail: 'x@mail.com',
      participantDocClean: '',
      participantDocType: null,
      buyer: { userId: BUYER, email: 'buyer@mail.com', docClean: '11122233344', docType: DocumentType.CPF },
      matchedUserId: null,
    });
    expect(r.isGift).toBe(true);
    expect(r.participantUserId).toBeNull();
  });

  it('tipo do comprador desconhecido (null) mas número igual → mesma pessoa (não presente)', () => {
    const r = decideParticipantIdentity({
      participantEmail: 'novo@mail.com',
      participantDocClean: '11122233344',
      participantDocType: DocumentType.CPF,
      buyer: { userId: BUYER, email: 'buyer@mail.com', docClean: '11122233344', docType: null },
      matchedUserId: null,
    });
    expect(r.isGift).toBe(false);
    expect(r.participantUserId).toBe(BUYER);
  });
});

describe('isSameNaturalPerson', () => {
  it('números vazios nunca casam', () => {
    expect(isSameNaturalPerson('', DocumentType.CPF, '11122233344', DocumentType.CPF)).toBe(false);
    expect(isSameNaturalPerson('11122233344', DocumentType.CPF, '', DocumentType.CPF)).toBe(false);
  });
  it('mesmo número + mesmo tipo → true', () => {
    expect(isSameNaturalPerson('11122233344', DocumentType.CPF, '11122233344', DocumentType.CPF)).toBe(true);
  });
  it('mesmo número, um tipo null → true (tolerante)', () => {
    expect(isSameNaturalPerson('11122233344', null, '11122233344', DocumentType.CPF)).toBe(true);
  });
  it('mesmo número, tipos conhecidos e diferentes → false', () => {
    expect(isSameNaturalPerson('11122233344', DocumentType.PASSPORT, '11122233344', DocumentType.CPF)).toBe(false);
  });
});

describe('resolveBuyerDocument', () => {
  it('usa documentNumberClean quando presente', () => {
    expect(
      resolveBuyerDocument({ documentType: DocumentType.CPF, documentNumber: '111.222.333-44', documentNumberClean: '11122233344' }),
    ).toEqual({ docClean: '11122233344', docType: DocumentType.CPF });
  });

  // Caso REAL do bug: conta legada com documentNumber FORMATADO e clean nulo.
  it('deriva o clean do documentNumber formatado quando documentNumberClean é null', () => {
    expect(
      resolveBuyerDocument({ documentType: DocumentType.CPF, documentNumber: '111.222.333-44', documentNumberClean: null }),
    ).toEqual({ docClean: '11122233344', docType: DocumentType.CPF });
  });

  it('deriva o clean quando documentNumberClean é string vazia', () => {
    expect(
      resolveBuyerDocument({ documentType: DocumentType.CPF, documentNumber: '11122233344', documentNumberClean: '' }),
    ).toEqual({ docClean: '11122233344', docType: DocumentType.CPF });
  });

  it('infere o tipo quando documentType é null (11 dígitos → CPF)', () => {
    expect(
      resolveBuyerDocument({ documentType: null, documentNumber: '111.222.333-44', documentNumberClean: null }),
    ).toEqual({ docClean: '11122233344', docType: DocumentType.CPF });
  });

  it('sem nenhum documento → clean vazio, tipo null', () => {
    expect(resolveBuyerDocument({})).toEqual({ docClean: '', docType: null });
  });
});
