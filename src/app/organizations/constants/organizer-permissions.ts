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

export function fullPermissionsMapFromJson(
  value: unknown,
): OrganizerPermissionsMap | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const out = { ...DEFAULT_NEW_MEMBER_PERMISSIONS };
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

  // create_event → acesso equivalente a OWNER em tudo
  if (parsed.create_event) {
    return { ...FULL_ORGANIZER_PERMISSIONS };
  }

  // notify → implica view_event
  if (parsed.notify) {
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
