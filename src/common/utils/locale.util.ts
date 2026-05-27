import * as path from 'path';
import {
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';
import * as countries from 'i18n-iso-countries';

/**
 * Utils de internacionalização: resolução de país pra ISO-3166 alpha-2,
 * detecção de brasileiro, formatação de telefone por país e formatação
 * de CPF.
 *
 * Compartilhado entre o template do PDF de ingresso e o `email.service`
 * (templates Mustache que recebem strings já formatadas).
 */

/* Carrega TODOS os locales do `i18n-iso-countries` no boot — qualquer nome
 * em qualquer idioma suportado resolve. `fs.readdirSync` roda 1x. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');
const LANGS_DIR = path.dirname(
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require.resolve('i18n-iso-countries/langs/en.json'),
);
const ALL_LOCALES: any[] = (() => {
  try {
    return (fs.readdirSync(LANGS_DIR) as string[])
      .filter((f) => f.endsWith('.json'))
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      .map((f) => require(path.join(LANGS_DIR, f)));
  } catch {
    return [];
  }
})();
const SUPPORTED_LOCALE_CODES: string[] = (() => {
  try {
    return (fs.readdirSync(LANGS_DIR) as string[])
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''));
  } catch {
    return [];
  }
})();

let localesRegistered = false;
function ensureLocales(): void {
  if (localesRegistered) return;
  for (const locale of ALL_LOCALES) {
    try {
      (countries as any).registerLocale(locale);
    } catch {
      // ignora — idempotente
    }
  }
  localesRegistered = true;
}

/* Overrides PT-BR pros nomes que `i18n-iso-countries` resolve em PT-PT.
 * Sincronizado com frontend src/utils/phone.ts. */
const PT_BR_ALIASES: Record<string, CountryCode> = {
  'armênia': 'AM',
  'barém': 'BH',
  'bósnia e herzegovina': 'BA',
  'brasil': 'BR',
  'catar': 'QA',
  'estados unidos': 'US',
  'reino unido': 'GB',
  'djibuti': 'DJ',
  'eslovênia': 'SI',
  'estônia': 'EE',
  'iêmen': 'YE',
  'irã': 'IR',
  'letônia': 'LV',
  'macedônia do norte': 'MK',
  'mianmar': 'MM',
  'mônaco': 'MC',
  'palestina': 'PS',
  'polônia': 'PL',
  'quênia': 'KE',
  'romênia': 'RO',
  'são cristóvão e nevis': 'KN',
  'seicheles': 'SC',
  'trinidad e tobago': 'TT',
  'turcomenistão': 'TM',
  'vaticano': 'VA',
  'vietnã': 'VN',
};

const isoLookupCache = new Map<string, CountryCode | null>();

/**
 * Resolve nome do país (em qualquer idioma) ou código ISO pra alpha-2.
 *   - null/empty → 'BR' (default histórico, cadastros legados sem país).
 *   - PT-BR aliases primeiro.
 *   - Lookup em todos os 77 locales do i18n-iso-countries.
 *   - alpha-2 cru ("BR", "AR").
 *   - alpha-3 cru ("BRA", "USA") via alpha3ToAlpha2.
 *   - Caso contrário null.
 */
export function getISOFromCountry(country?: string | null): CountryCode | null {
  /* Sem country → null (NAO assume BR default). Caller deve tratar null
   * como "nao formatar". Assumir BR escondia bug: contas legadas sem
   * country (incluindo argentinos que nao tinham o campo) caiam em
   * AsYouType('BR') e distorciam o telefone como brasileiro. */
  if (!country || !country.trim()) return null;
  ensureLocales();
  const key = country.trim();
  if (isoLookupCache.has(key)) return isoLookupCache.get(key) as CountryCode | null;

  const lowered = key.toLowerCase();
  let code: string | undefined;

  if (PT_BR_ALIASES[lowered]) {
    code = PT_BR_ALIASES[lowered];
  }
  if (!code) {
    for (const locale of SUPPORTED_LOCALE_CODES) {
      code = (countries as any).getAlpha2Code(key, locale) as string | undefined;
      if (code) break;
      code = (countries as any).getAlpha2Code(lowered, locale) as string | undefined;
      if (code) break;
    }
  }
  if (!code && /^[a-zA-Z]{2}$/.test(key)) {
    const upper = key.toUpperCase();
    if ((countries as any).isValid(upper)) code = upper;
  }
  if (!code && /^[a-zA-Z]{3}$/.test(key)) {
    code = (countries as any).alpha3ToAlpha2(key.toUpperCase()) as string | undefined;
  }

  const result = (code as CountryCode) || null;
  isoLookupCache.set(key, result);
  return result;
}

/**
 * Decide se o usuário é brasileiro.
 *
 * Prioridade (mais autoritativo → menos):
 *   1. documentType === 'PASSPORT' → estrangeiro.
 *   2. Doc tem letras [A-Za-z] → estrangeiro (passaporte).
 *   3. country mapeado pra outro país → estrangeiro.
 *   4. ISO bate com 'BR' → brasileiro.
 *   5. country null/vazio + doc só dígitos + sem PASSPORT → assume BR.
 */
export function isBrazilian(
  country?: string | null,
  documentType?: 'CPF' | 'PASSPORT' | string | null,
  doc?: string | null,
): boolean {
  /* PASSPORT explicito = estrangeiro. */
  if (documentType === 'PASSPORT') return false;
  /* Doc com letras = passaporte. */
  if (doc && /[A-Za-z]/.test(doc)) return false;
  const iso = getISOFromCountry(country);
  if (iso === 'BR') return true;
  if (iso !== null) return false;
  /* country null e nem PASSPORT nem doc com letras: cai em documentType
   * (cadastros brasileiros legados tem CPF default). */
  return documentType === 'CPF';
}

/**
 * Formata telefone conforme país usando `libphonenumber-js` AsYouType.
 * Para estrangeiros sem country mapeado, retorna só dígitos limpos.
 */
export function formatPhoneByCountry(
  phone?: string | null,
  country?: string | null,
  documentType?: 'CPF' | 'PASSPORT' | string | null,
  doc?: string | null,
): string {
  if (!phone) return phone ?? '';
  const digits = phone.replace(/\D/g, '');
  /* Resolve ISO via country (Argentina → AR, Brasil → BR). PASSPORT importa
   * so pro fallback isBrazilian (cadastros legados sem country). */
  let iso = getISOFromCountry(country);
  if (!iso && isBrazilian(country, documentType, doc)) {
    iso = 'BR';
  }
  if (iso) {
    try {
      /* parsePhoneNumberFromString → formatNational. Reconhece numeros
       * nacionais validos do pais e formata com mascara oficial. Se
       * invalido, retorna digitos crus — nao fazer best-effort que
       * gera formato errado (ex: AR sem trunk '0'). */
      const parsed = parsePhoneNumberFromString(phone, iso);
      if (parsed && parsed.isValid()) {
        return parsed.formatNational();
      }
    } catch {
      /* fall through */
    }
  }
  return digits;
}

/**
 * Formata CPF brasileiro (xxx.xxx.xxx-xx). Para estrangeiros (não-BR),
 * retorna valor cru sem aplicar máscara. Quando o input não tem 11 dígitos
 * (já incompleto ou já formatado), retorna como veio.
 */
export function formatCpfByCountry(
  cpf?: string | null,
  country?: string | null,
  documentType?: 'CPF' | 'PASSPORT' | string | null,
): string {
  if (!cpf) return '';
  if (!isBrazilian(country, documentType, cpf)) {
    return cpf;
  }
  const d = cpf.replace(/\D/g, '');
  if (d.length !== 11) return cpf;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/**
 * Label dinâmico do campo de documento conforme nacionalidade. Use em
 * subjects, textos plain e logs.
 */
export function documentLabelByCountry(
  country?: string | null,
  documentType?: 'CPF' | 'PASSPORT' | string | null,
  doc?: string | null,
): 'CPF' | 'Documento' {
  return isBrazilian(country, documentType, doc) ? 'CPF' : 'Documento';
}
