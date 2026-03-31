import type { Event } from '@prisma/client';
import type { UpdateEventDto } from './dto/create-event.dto';

const DATE_FIELDS = [
  'eventDate',
  'registrationStartDate',
  'registrationEndDate',
] as const;

/** Rótulos curtos para o texto do log (pt-BR). */
export const EVENT_UPDATE_FIELD_LABELS: Record<string, string> = {
  name: 'nome',
  slug: 'slug',
  description: 'descrição',
  bannerUrl: 'banner',
  logoUrl: 'logo',
  location: 'local',
  city: 'cidade',
  state: 'estado',
  country: 'país',
  zipCode: 'CEP',
  neighborhood: 'bairro',
  googleMapsLink: 'link do mapa',
  regulationUrl: 'regulamento',
  eventDate: 'data do evento',
  registrationStartDate: 'início das inscrições',
  registrationEndDate: 'fim das inscrições',
  status: 'status',
  kitSelectionDisplay: 'exibição de imagens do kit na escolha de ingressos',
};

export function serializeAuditValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Compara apenas chaves presentes no PATCH com o estado atual; ignora campos não alterados.
 */
export function diffEventUpdateForAudit(
  before: Event,
  dto: UpdateEventDto,
): Array<{ field: string; old: unknown; new: unknown }> {
  const out: Array<{ field: string; old: unknown; new: unknown }> = [];
  const keys = Object.keys(dto) as (keyof UpdateEventDto)[];
  for (const key of keys) {
    if (key === 'clientPage') continue;
    const rawNew = dto[key];
    if (rawNew === undefined) continue;

    const oldVal = before[key as keyof Event];

    if ((DATE_FIELDS as readonly string[]).includes(key)) {
      const newTime = new Date(rawNew as string).getTime();
      const oldTime =
        oldVal instanceof Date
          ? oldVal.getTime()
          : typeof oldVal === 'string'
            ? new Date(oldVal).getTime()
            : NaN;
      if (newTime === oldTime || (Number.isNaN(oldTime) && Number.isNaN(newTime))) {
        continue;
      }
      out.push({
        field: key,
        old: serializeAuditValue(oldVal),
        new: serializeAuditValue(new Date(rawNew as string)),
      });
      continue;
    }

    if (oldVal === rawNew) continue;
    if (String(oldVal ?? '') === String(rawNew ?? '')) continue;

    out.push({
      field: key,
      old: serializeAuditValue(oldVal),
      new: serializeAuditValue(rawNew),
    });
  }
  return out;
}

/**
 * Diff do que de fato vai no `prisma.event.update` (inclui slug recalculado, datas como Date, etc.).
 * Evita audit vazio quando o DTO não reflete o payload final.
 */
export function diffEventUpdateAgainstData(
  before: Event,
  updateData: Record<string, unknown>,
): Array<{ field: string; old: unknown; new: unknown }> {
  const out: Array<{ field: string; old: unknown; new: unknown }> = [];
  for (const key of Object.keys(updateData)) {
    const rawNew = updateData[key];
    if (rawNew === undefined) continue;

    const oldVal = before[key as keyof Event];

    if ((DATE_FIELDS as readonly string[]).includes(key)) {
      const newTime =
        rawNew instanceof Date
          ? rawNew.getTime()
          : new Date(String(rawNew)).getTime();
      const oldTime =
        oldVal instanceof Date
          ? oldVal.getTime()
          : typeof oldVal === 'string'
            ? new Date(oldVal).getTime()
            : NaN;
      if (
        newTime === oldTime ||
        (Number.isNaN(oldTime) && Number.isNaN(newTime))
      ) {
        continue;
      }
      const newAsDate =
        rawNew instanceof Date ? rawNew : new Date(String(rawNew));
      out.push({
        field: key,
        old: serializeAuditValue(oldVal),
        new: serializeAuditValue(newAsDate),
      });
      continue;
    }

    if (key === 'kitSelectionDisplay') {
      const norm = (v: unknown) =>
        v === null || v === undefined ? 'null' : JSON.stringify(v);
      if (norm(oldVal) === norm(rawNew)) {
        continue;
      }
      out.push({
        field: key,
        old: serializeAuditValue(oldVal),
        new: serializeAuditValue(rawNew),
      });
      continue;
    }

    if (oldVal === rawNew) continue;
    if (String(oldVal ?? '') === String(rawNew ?? '')) continue;

    out.push({
      field: key,
      old: serializeAuditValue(oldVal),
      new: serializeAuditValue(rawNew),
    });
  }
  return out;
}

export function summarizeEventFieldChanges(
  changes: Array<{ field: string }>,
): string {
  if (changes.length === 0) return '';
  const labels = changes.map(
    (c) => EVENT_UPDATE_FIELD_LABELS[c.field] ?? c.field,
  );
  return labels.join(', ');
}
