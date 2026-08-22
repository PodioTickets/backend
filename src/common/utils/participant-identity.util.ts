import { DocumentType } from '@prisma/client';
import { cleanDocumentNumber, inferDocumentType } from './document.util';

/**
 * Identidade do participante de uma inscrição vs. o COMPRADOR — decide se a inscrição
 * é para OUTRA pessoa (presente) ou para o próprio comprador, e a qual conta vincular.
 *
 * REGRA (fonte única — usada no finalize da compra):
 *   1. Mesmo e-mail do comprador → é o próprio comprador. Vincula à conta dele, NÃO é
 *      presente, e não precisa de snapshot (usa os dados vivos da conta).
 *   2. E-mail DIFERENTE → precisa de snapshot (o participante pode ter dados próprios).
 *      Aqui a identidade canônica é o DOCUMENTO (CPF/passaporte), não o e-mail:
 *        - Se o documento do participante == documento do COMPRADOR → é a própria
 *          pessoa que trocou só o e-mail. Vincula ao comprador e NÃO é presente.
 *        - Senão, vincula à conta encontrada pelo lookup global (`matchedUserId`), ou
 *          fica sem conta (guest). Em ambos os casos É presente (`invitedById` != null).
 *
 * Isso corrige o bug em que "comprar pra si mesmo trocando só o e-mail" ia como
 * PRESENTE: a comparação por e-mail sozinha falha, e o lookup global por documento
 * falha em contas legadas sem `documentNumberClean` — a comparação DIRETA contra o
 * documento do comprador (com fallback de normalização) resolve os dois casos.
 */

export interface ParticipantIdentityInput {
  /** E-mail digitado para o participante (pode diferir do comprador). */
  participantEmail?: string | null;
  /** Documento do participante já normalizado (ex.: `resolveDocument(pData).clean`). */
  participantDocClean: string;
  participantDocType: DocumentType | null;
  /** Comprador autenticado + seu documento canônico (ver `resolveBuyerDocument`). */
  buyer: {
    userId: string;
    email?: string | null;
    docClean: string;
    docType: DocumentType | null;
  };
  /** Conta USER encontrada pelo lookup global (documento→e-mail); null se nenhuma. */
  matchedUserId: string | null;
}

export interface ParticipantIdentityResult {
  /** Conta a vincular na `Registration.userId` (null = guest, sem conta). */
  participantUserId: string | null;
  /** true = inscrição para OUTRA pessoa → grava `invitedById` (presente no e-mail). */
  isGift: boolean;
  /** true = e-mail difere do comprador → gravar snapshot do participante digitado. */
  needsSnapshot: boolean;
}

/** Normaliza dois documentos e diz se representam a MESMA pessoa (mesmo número + tipo
 *  quando ambos conhecidos). Números vazios nunca casam (sem documento, sem match). */
export function isSameNaturalPerson(
  aClean: string,
  aType: DocumentType | null,
  bClean: string,
  bType: DocumentType | null,
): boolean {
  if (!aClean || !bClean) return false;
  if (aClean !== bClean) return false;
  // Tipos conhecidos precisam bater (evita colisão CPF×passaporte de mesmo número).
  if (aType != null && bType != null && aType !== bType) return false;
  return true;
}

export function decideParticipantIdentity(
  input: ParticipantIdentityInput,
): ParticipantIdentityResult {
  const sameEmail =
    !!input.participantEmail &&
    !!input.buyer.email &&
    input.participantEmail.toLowerCase() === input.buyer.email.toLowerCase();

  if (sameEmail) {
    // Próprio comprador (mesmo e-mail) → conta do comprador, sem snapshot, sem presente.
    return { participantUserId: input.buyer.userId, isGift: false, needsSnapshot: false };
  }

  // E-mail diferente → é o comprador que trocou o e-mail? (mesmo documento) OU outra pessoa.
  const isBuyerBySelfDocument = isSameNaturalPerson(
    input.participantDocClean,
    input.participantDocType,
    input.buyer.docClean,
    input.buyer.docType,
  );

  const participantUserId = isBuyerBySelfDocument
    ? input.buyer.userId
    : input.matchedUserId;

  const isGuest = participantUserId === null;
  const isDifferentUser =
    participantUserId !== null && participantUserId !== input.buyer.userId;

  return {
    participantUserId,
    isGift: isDifferentUser || isGuest,
    needsSnapshot: true,
  };
}

/**
 * Documento canônico do COMPRADOR (limpo + tipo) a partir da conta, tolerando o estado
 * de compat/backfill: usa `documentNumberClean` quando presente; senão deriva do
 * `documentNumber` (que pode estar COM formatação) via `cleanDocumentNumber`. O tipo
 * cai para a inferência quando ausente. Sem isso, contas legadas (clean nulo) faziam a
 * comparação por documento falhar → "compra pra si mesmo" ia como presente.
 */
export function resolveBuyerDocument(buyer: {
  documentType?: DocumentType | null;
  documentNumber?: string | null;
  documentNumberClean?: string | null;
}): { docClean: string; docType: DocumentType | null } {
  const type =
    buyer.documentType ??
    (buyer.documentNumber ? inferDocumentType(buyer.documentNumber) : null);
  const docClean =
    (buyer.documentNumberClean && buyer.documentNumberClean.trim()) ||
    cleanDocumentNumber(buyer.documentNumber, type);
  return { docClean, docType: type };
}
