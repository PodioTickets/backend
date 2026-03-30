import { EVENT_UPDATE_FIELD_LABELS } from '../events/event-audit.helpers';
import { TICKET_FIELD_LABELS } from '../tickets/ticket-audit.helpers';
import { PRODUCT_FIELD_LABELS } from '../products/product-audit.helpers';

const ORG_AUDIT_FIELD_LABELS: Record<string, string> = {
  role: 'papel',
  permissions: 'permissões',
  eventIds: 'eventos permitidos',
  colaborador: 'colaborador',
  evento: 'evento',
  produto: 'produto',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isChangeEntry(v: unknown): v is { field: string; old: unknown; new: unknown } {
  if (!isRecord(v)) return false;
  return typeof v.field === 'string' && 'old' in v && 'new' in v;
}

function fieldLabelForAuditKind(
  kind: string | undefined,
  field: string,
): string {
  if (kind === 'EVENT_UPDATE') {
    return EVENT_UPDATE_FIELD_LABELS[field] ?? field;
  }
  if (kind === 'TICKET_UPDATE') {
    return TICKET_FIELD_LABELS[field] ?? field;
  }
  if (kind === 'PRODUCT_UPDATE') {
    return PRODUCT_FIELD_LABELS[field] ?? field;
  }
  return ORG_AUDIT_FIELD_LABELS[field] ?? field;
}

export type AuditChangeDetail = {
  field: string;
  fieldLabel: string;
  oldValue: unknown;
  newValue: unknown;
};

/**
 * Expõe cada alteração registrada em `metadata.changes` (admin / suporte).
 */
export function buildAuditChangeDetails(
  metadata: unknown,
): AuditChangeDetail[] | null {
  if (!isRecord(metadata)) return null;
  const raw = metadata.changes;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const kind =
    typeof metadata.kind === 'string' ? metadata.kind : undefined;
  const out: AuditChangeDetail[] = [];
  for (const item of raw) {
    if (!isChangeEntry(item)) continue;
    out.push({
      field: item.field,
      fieldLabel: fieldLabelForAuditKind(kind, item.field),
      oldValue: item.old,
      newValue: item.new,
    });
  }
  return out.length > 0 ? out : null;
}
