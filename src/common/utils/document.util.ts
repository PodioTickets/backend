import { DocumentType } from '@prisma/client';

/**
 * Normaliza um número de documento para uso em chaves únicas, índices e
 * comparações (busca, dedupe, cupom/voucher cpfList).
 *
 * Regra única do projeto — não chame `.replace(/\D/g, '')` direto em código
 * novo, isso quebra estrangeiros (passaporte tem letras e elas são parte
 * essencial do número).
 *
 *   - CPF (ou tipo nulo/desconhecido tratado como CPF — assume contexto
 *     brasileiro legado): remove formatação e mantém só dígitos.
 *   - PASSPORT (e demais tipos estrangeiros que vierem no futuro):
 *     uppercase + strip de TUDO que não é alfanumérico ([^A-Z0-9]).
 *     Bloqueia formatação histórica (espaços, pontos, hífens) E caracteres
 *     especiais inesperados (/, \, *, @, #, etc.) — defesa em profundidade
 *     contra input sujo do front que driblar o regex do DTO.
 *
 * Retorna string vazia para entrada nula/vazia para permitir uso direto
 * com `??` nos call-sites sem checagens extras.
 */
export function cleanDocumentNumber(
  raw: string | null | undefined,
  type: DocumentType | null | undefined,
): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // Default conservador: tratar tipo ausente como CPF (preserva comportamento
  // histórico dos call-sites). PASSPORT é opt-in explícito.
  if (!type || type === DocumentType.CPF) {
    return trimmed.replace(/\D/g, '');
  }

  // Strip não-alfanumérico após uppercase. Equivalente a manter [A-Z0-9].
  return trimmed.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Infere o tipo do documento quando o cliente não informa (compat com
 * clientes legacy que só mandam `cpf`/`documentNumber` sem `documentType`).
 *
 * Heurística:
 *   - 11 dígitos puros, sem letras → CPF.
 *   - Qualquer outra coisa → PASSPORT.
 *
 * Usada na fase de transição. Quando o front 100% migrado mandar sempre
 * `documentType`, esta função vira opcional.
 */
export function inferDocumentType(raw: string | null | undefined): DocumentType {
  if (!raw) return DocumentType.CPF;
  const trimmed = raw.trim();
  if (!trimmed) return DocumentType.CPF;

  // CPF: só dígitos e formatação aceita (pontos, hífens, espaços). 11 dígitos
  // depois de strip. Letras presentes => não pode ser CPF.
  const hasLetters = /[A-Za-z]/.test(trimmed);
  if (hasLetters) return DocumentType.PASSPORT;

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11) return DocumentType.CPF;

  return DocumentType.PASSPORT;
}

/** Item canônico de documentList (Coupon/Voucher). */
export interface DocumentListEntry {
  type: DocumentType;
  numberClean: string;
}

/**
 * Constrói `documentList` a partir do payload do DTO de cupom/voucher.
 *
 * Aceita `documentList` (preferencial, internacionalizado) e/ou `cpfList`
 * (legacy, só CPFs). Quando só `cpfList` vem, é auto-convertido pra shape
 * canônico. Quando ambos vêm, `documentList` ganha. Normaliza cada item
 * via cleanDocumentNumber respeitando o tipo declarado.
 *
 * Retorna `null` quando ambos estão vazios — permite gravar `null` direto
 * no Prisma.
 */
export function buildDocumentList(input: {
  documentList?: ReadonlyArray<{ type: DocumentType; numberClean: string }> | null;
  cpfList?: ReadonlyArray<string> | null;
}): DocumentListEntry[] | null {
  if (input.documentList && input.documentList.length > 0) {
    return input.documentList
      .map((entry) => ({
        type: entry.type,
        numberClean: cleanDocumentNumber(entry.numberClean, entry.type),
      }))
      .filter((entry) => entry.numberClean.length > 0);
  }
  if (input.cpfList && input.cpfList.length > 0) {
    return input.cpfList
      .map((cpf) => ({
        type: DocumentType.CPF,
        numberClean: cleanDocumentNumber(cpf, DocumentType.CPF),
      }))
      .filter((entry) => entry.numberClean.length > 0);
  }
  return null;
}

/**
 * Lookup de elegibilidade em documentList de cupom/voucher, com fallback
 * pra `cpfList` legado em registros que ainda não foram migrados.
 *
 * Estratégia:
 *   1. Se `documentList` existe, comparar `{type, numberClean}` exatos.
 *   2. Senão (cupom antigo pré-backfill), comparar `numberClean` puro
 *      contra `cpfList` — preserva semântica legada (só CPFs).
 *
 * Retorna false se o usuário não tem documento cadastrado (sem documento,
 * sem match — segurança).
 */
export function isDocumentInList(
  user: { documentType?: DocumentType | null; documentNumberClean?: string | null },
  documentList: unknown,
  cpfList: unknown,
): boolean {
  if (!user.documentNumberClean) return false;

  if (Array.isArray(documentList) && documentList.length > 0) {
    return documentList.some(
      (entry: any) =>
        entry &&
        entry.type === user.documentType &&
        typeof entry.numberClean === 'string' &&
        entry.numberClean === user.documentNumberClean,
    );
  }

  if (Array.isArray(cpfList) && cpfList.length > 0) {
    // Fallback legado: cpfList só comparada contra usuários CPF, pra evitar
    // que um passaporte "12345678901" colida acidentalmente com um CPF.
    if (user.documentType && user.documentType !== DocumentType.CPF) return false;
    const userClean = cleanDocumentNumber(user.documentNumberClean, DocumentType.CPF);
    return (cpfList as unknown[]).some(
      (c) => typeof c === 'string' && cleanDocumentNumber(c, DocumentType.CPF) === userClean,
    );
  }

  return false;
}

/**
 * Resolve `documentType` + `documentNumberClean` a partir do payload de um
 * DTO que pode vir com qualquer combinação de:
 *   - `documentType` + `documentNumber` (novo, preferido)
 *   - `cpf` + `documentType` (front parcialmente migrado)
 *   - `cpf` puro (legacy)
 *
 * Centraliza a regra de prioridade num único ponto pra evitar drift entre
 * services. Retorna `null` em ambos os campos quando o input é vazio.
 */
export function resolveDocument(input: {
  documentType?: DocumentType | null;
  documentNumber?: string | null;
  cpf?: string | null;
}): { type: DocumentType | null; number: string; clean: string } {
  const raw = (input.documentNumber ?? input.cpf ?? '').trim();
  if (!raw) {
    return { type: null, number: '', clean: '' };
  }
  const type = input.documentType ?? inferDocumentType(raw);
  return {
    type,
    number: raw,
    clean: cleanDocumentNumber(raw, type),
  };
}
