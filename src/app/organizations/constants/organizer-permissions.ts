export const ORGANIZER_PERMISSION_KEYS = [
  'dashboard',
  'financial',
  'create_event',
  'edit_event',
  'view_event',
  'coupons',
  'pixel',
  'notify',
] as const;

export type OrganizerPermissionKey = (typeof ORGANIZER_PERMISSION_KEYS)[number];

export type OrganizerPermissionsMap = Record<OrganizerPermissionKey, boolean>;

export function isOrganizerPermissionKey(k: string): k is OrganizerPermissionKey {
  return (ORGANIZER_PERMISSION_KEYS as readonly string[]).includes(k);
}

export class UnknownOrganizerPermissionKeyError extends Error {
  constructor(public readonly raw: string) {
    super(`Unknown permission key: ${raw}`);
    this.name = 'UnknownOrganizerPermissionKeyError';
  }
}

function normalizeKeyInput(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Resolve a single permission string to a canonical key (case-insensitive). */
export function resolvePermissionKey(raw: string): OrganizerPermissionKey | null {
  const n = normalizeKeyInput(raw);
  if (!n) return null;
  return isOrganizerPermissionKey(n) ? n : null;
}

/** `permissions` array from client → map to store. Replacement: only listed keys are true. */
export function mapFromPermissionKeys(keys: string[]): OrganizerPermissionsMap {
  const out: OrganizerPermissionsMap = {
    dashboard: false,
    financial: false,
    create_event: false,
    edit_event: false,
    view_event: false,
    coupons: false,
    pixel: false,
    notify: false,
  };
  const seen = new Set<OrganizerPermissionKey>();
  for (const raw of keys) {
    const key = resolvePermissionKey(raw);
    if (!key) {
      throw new UnknownOrganizerPermissionKeyError(raw);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out[key] = true;
  }
  return out;
}

/** Stored map → granted keys in canonical order (same as `ORGANIZER_PERMISSION_KEYS`). */
export function grantedPermissionKeys(map: OrganizerPermissionsMap): OrganizerPermissionKey[] {
  const list: OrganizerPermissionKey[] = [];
  for (const key of ORGANIZER_PERMISSION_KEYS) {
    if (map[key]) {
      list.push(key);
    }
  }
  return list;
}

export const FULL_ORGANIZER_PERMISSIONS: OrganizerPermissionsMap = {
  dashboard: true,
  financial: true,
  create_event: true,
  edit_event: true,
  view_event: true,
  coupons: true,
  pixel: true,
  notify: true,
};

/** Default for new members when `permissions` is omitted. */
export const DEFAULT_NEW_MEMBER_PERMISSIONS: OrganizerPermissionsMap = {
  dashboard: true,
  view_event: true,
  financial: false,
  create_event: false,
  edit_event: false,
  coupons: false,
  pixel: false,
  notify: false,
};

export function mergePermissionsFromInput(
  input: Record<string, boolean> | undefined | null,
  base: OrganizerPermissionsMap,
): OrganizerPermissionsMap {
  const out = { ...base };
  if (!input) return out;
  for (const key of ORGANIZER_PERMISSION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      out[key] = Boolean(input[key]);
    }
  }
  return out;
}

const NO_ORGANIZER_PERMISSIONS: OrganizerPermissionsMap = {
  dashboard: false,
  financial: false,
  create_event: false,
  edit_event: false,
  view_event: false,
  coupons: false,
  pixel: false,
  notify: false,
};

/**
 * `permissions` do banco → mapa. `null` significa "nunca configurado" e o chamador
 * trata como acesso total (legado) — ver `effectivePermissionsForMember`.
 *
 * Aceita DOIS formatos porque o banco tem os dois:
 *  - MAPA `{ financial: true, ... }` — canônico, gravado pelo fluxo do organizador;
 *  - ARRAY `["financial", ...]` — legado, gravado pelo PATCH do painel admin.
 *
 * O array precisa ser entendido AQUI, não só corrigido na escrita: enquanto ele
 * caía no `return null`, o chamador concedia FULL_ORGANIZER_PERMISSIONS — ou seja,
 * restringir permissões pelo admin dava ACESSO TOTAL ao colaborador (o oposto da
 * intenção), e continuaria dando para todas as linhas já gravadas.
 * Semântica de substituição: só as chaves listadas são concedidas.
 */
export function fullPermissionsMapFromJson(
  value: unknown,
): OrganizerPermissionsMap | null {
  if (value == null) return null;

  if (Array.isArray(value)) {
    const out = { ...NO_ORGANIZER_PERMISSIONS };
    for (const raw of value) {
      if (typeof raw !== 'string') continue;
      const key = resolvePermissionKey(raw);
      if (key) out[key] = true;
    }
    return out;
  }

  if (typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  // SUBSTITUIÇÃO, igual ao ramo do array e ao escritor (`mapFromPermissionKeys`):
  // a base é "nada concedido", nunca o default de membro novo. Com a base no
  // default, qualquer chave AUSENTE do mapa gravado (linha legada, mapa parcial,
  // `{}`) reaparecia concedida — o organizador removia `view_event` e ela voltava
  // sozinha na leitura. `dashboard` não se perde: é derivada logo abaixo, em
  // `effectivePermissionsForMember`.
  const out = { ...NO_ORGANIZER_PERMISSIONS };
  for (const key of ORGANIZER_PERMISSION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(o, key)) {
      out[key] = Boolean(o[key]);
    }
  }
  return out;
}

export function effectivePermissionsForMember(params: {
  role: 'OWNER' | 'EMPLOYEE';
  permissionsJson: unknown;
}): OrganizerPermissionsMap {
  if (params.role === 'OWNER') {
    return { ...FULL_ORGANIZER_PERMISSIONS };
  }
  const parsed = fullPermissionsMapFromJson(params.permissionsJson);
  if (parsed === null) {
    return { ...FULL_ORGANIZER_PERMISSIONS };
  }

  // create_event pressupõe poder EDITAR e VISUALIZAR o evento (quem cria precisa
  // mexer nele e vê-lo), mas NÃO concede as demais permissões (financeiro,
  // cupons, pixel, notificar). Antes create_event equivalia a acesso total —
  // divergia do drawer (que passou a ligar só Editar+Visualizar) e reacendia
  // todos os checkboxes ao reabrir. Menor privilégio + paridade UI↔backend.
  if (parsed.create_event) {
    parsed.edit_event = true;
    parsed.view_event = true;
  }

  // dashboard → derivado: qualquer outra permissão ativa garante acesso ao dashboard
  const hasAnyPermission = ORGANIZER_PERMISSION_KEYS
    .filter((k) => k !== 'dashboard')
    .some((k) => parsed[k]);
  if (hasAnyPermission) {
    parsed.dashboard = true;
  }

  return parsed;
}
