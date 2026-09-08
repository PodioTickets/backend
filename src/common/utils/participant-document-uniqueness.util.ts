import { resolveDocument } from './document.util';

/**
 * Regra "1 ingresso por CPF por evento" (`Event.allowMultipleTicketsPerCpf`).
 *
 * Quando a flag do evento está DESLIGADA (default), o mesmo documento não pode
 * levar mais de um ingresso no evento — nem repetido dentro do mesmo pedido
 * (inclusive entre ingressos de TIPOS DIFERENTES), nem somando a uma inscrição
 * que já existe de um pedido anterior.
 *
 * Aqui mora só a parte PURA: normalizar, achar repetição e montar a mensagem.
 * A consulta ao banco e o `throw` ficam nos call-sites (orders/patchParticipants
 * e a finalização do pedido), porque cada um tem seu client e sua transação.
 */

export interface ParticipantDocumentSlot {
  /** Índice do slot em `pendingParticipants` — mesma ordem dos cards do checkout. */
  slot: number;
  /** Documento normalizado: dígitos no CPF, alfanumérico maiúsculo no passaporte. */
  clean: string;
}

/**
 * Documentos preenchidos, já normalizados. Slots VAZIOS ficam de fora: o
 * `reserve` completa `pendingParticipants` com `{}` até a quantidade reservada,
 * e slot sem documento não é duplicata de nada — é só um card ainda em branco.
 *
 * A normalização passa pelo mesmo `resolveDocument` que o `patchParticipants`
 * usa antes de persistir, então a comparação enxerga exatamente o que vai (ou
 * já foi) para o banco — "123.456.789-00" e "12345678900" são o mesmo CPF.
 */
export function collectParticipantDocuments(
  participants: readonly unknown[] | null | undefined,
): ParticipantDocumentSlot[] {
  const out: ParticipantDocumentSlot[] = [];
  (participants ?? []).forEach((p, slot) => {
    const { clean } = resolveDocument((p ?? {}) as any);
    if (clean) out.push({ slot, clean });
  });
  return out;
}

/**
 * Slots que repetem um documento já usado por um slot ANTERIOR do mesmo pedido.
 *
 * O primeiro slot de cada documento NÃO entra na lista de propósito: ele é o
 * que fica. Devolver só os seguintes deixa o checkout marcar erro exatamente
 * nos cards que o comprador precisa corrigir, em vez de acusar os dois e não
 * dizer qual manter.
 */
export function findRepeatedDocumentSlots(
  docs: readonly ParticipantDocumentSlot[],
): ParticipantDocumentSlot[] {
  const seen = new Set<string>();
  const repeated: ParticipantDocumentSlot[] = [];
  for (const d of docs) {
    if (seen.has(d.clean)) repeated.push(d);
    else seen.add(d.clean);
  }
  return repeated;
}

/** Documentos distintos do pedido — o `in` da consulta de inscrições existentes. */
export function distinctDocuments(
  docs: readonly ParticipantDocumentSlot[],
): string[] {
  return [...new Set(docs.map((d) => d.clean))];
}

/** Slots cujo documento está na lista de já inscritos no evento. */
export function findAlreadyRegisteredSlots(
  docs: readonly ParticipantDocumentSlot[],
  registeredClean: readonly string[],
): ParticipantDocumentSlot[] {
  const taken = new Set(registeredClean.filter(Boolean));
  return docs.filter((d) => taken.has(d.clean));
}

/** Código de erro único das duas violações — o front mapeia por ele. */
export const ONE_TICKET_PER_DOCUMENT_ERROR = 'ONE_TICKET_PER_DOCUMENT';

export function repeatedInOrderMessage(): string {
  return (
    'Este evento permite apenas um ingresso por CPF. ' +
    'Use um documento diferente em cada ingresso do pedido.'
  );
}

export function alreadyRegisteredMessage(): string {
  return (
    'Este evento permite apenas um ingresso por CPF, e este documento já tem ' +
    'inscrição neste evento.'
  );
}
