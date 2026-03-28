import { EVENT_UPDATE_FIELD_LABELS } from '../events/event-audit.helpers';

const EDIT_AUDIT_KINDS = new Set([
  'EVENT_UPDATE',
  'TICKET_UPDATE',
  'PRODUCT_UPDATE',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Para logs de edição (evento/ingresso/produto), separa o texto curto da ação
 * dos rótulos dos campos alterados. Compatível com registros antigos que
 * embutiam "(nome, banner)" em `action`.
 */
export function formatAuditLogItemForResponse(
  storedAction: string,
  metadata: unknown,
): { action: string; editedFields: string | null } {
  const meta = isRecord(metadata) ? metadata : null;
  const kind = typeof meta?.kind === 'string' ? meta.kind : undefined;

  if (kind && EDIT_AUDIT_KINDS.has(kind)) {
    let editedFields: string | null = null;
    if (kind === 'EVENT_UPDATE' && Array.isArray(meta?.fieldsEdited)) {
      const keys = meta.fieldsEdited as string[];
      editedFields =
        keys
          .map((k) => EVENT_UPDATE_FIELD_LABELS[k] ?? k)
          .filter(Boolean)
          .join(', ') || null;
    } else if (
      (kind === 'TICKET_UPDATE' || kind === 'PRODUCT_UPDATE') &&
      Array.isArray(meta?.fieldsEdited)
    ) {
      editedFields =
        (meta.fieldsEdited as string[]).filter(Boolean).join(', ') || null;
    } else {
      const tail = /\s+\(([^)]+)\)\s*$/.exec(storedAction);
      editedFields = tail ? tail[1].trim() : null;
    }

    const hasTrailingSummary = /\s+\([^)]+\)\s*$/.test(storedAction);
    const action = hasTrailingSummary
      ? storedAction.replace(/\s+\([^)]+\)\s*$/, '').trimEnd()
      : storedAction;

    return { action, editedFields };
  }

  // Registros muito antigos sem `kind` no metadata
  if (
    !kind &&
    /^Editou o (evento|ingresso|produto)\b/i.test(storedAction)
  ) {
    const tail = /\s+\(([^)]+)\)\s*$/.exec(storedAction);
    if (tail) {
      return {
        action: storedAction.slice(0, tail.index).trimEnd(),
        editedFields: tail[1].trim(),
      };
    }
  }

  return { action: storedAction, editedFields: null };
}
