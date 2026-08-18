import React from 'react';
import {
  Document,
  Page,
  View,
  Text,
  Image,
  Font,
  Svg,
  Path,
  Defs,
  LinearGradient as LinearGradientBase,
  Stop,
} from '@react-pdf/renderer';
import * as path from 'path';
import {
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';
import * as countries from 'i18n-iso-countries';

/* JSON locales carregados via require pra evitar precisar de
 * `resolveJsonModule` no tsconfig (o projeto nao usa essa flag). */
/* Carrega TODOS os 77 locales suportados pelo i18n-iso-countries pra que
 * qualquer nome de pais escrito em qualquer idioma seja resolvido.
 * `fs.readdirSync` roda 1 vez no boot e o `require` cacheia os JSONs. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');
const LANGS_DIR = path.dirname(
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require.resolve('i18n-iso-countries/langs/en.json'),
);
const ALL_LOCALES: any[] = (() => {
  try {
    const files = fs.readdirSync(LANGS_DIR) as string[];
    return files
      .filter((f: string) => f.endsWith('.json'))
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      .map((f: string) => require(path.join(LANGS_DIR, f)));
  } catch {
    return [];
  }
})();
const SUPPORTED_LOCALE_CODES: string[] = (() => {
  try {
    return (fs.readdirSync(LANGS_DIR) as string[])
      .filter((f: string) => f.endsWith('.json'))
      .map((f: string) => f.replace('.json', ''));
  } catch {
    return [];
  }
})();
import {
  TicketPdfProduct,
  TicketPdfRegistrationWithQr,
  TicketPdfTemplateData,
} from './ticket-pdf.types';

/* LinearGradient não exporta tipos corretos para gradientUnits/x1/y1/x2/y2 — cast necessário */
const LinearGradient = LinearGradientBase as any;

Font.registerHyphenationCallback((w) => [w]);

const FP = path.join(process.cwd(), 'node_modules', '@fontsource');
const dmSans = (w: number) =>
  path.join(FP, 'dm-sans', 'files', `dm-sans-latin-${w}-normal.woff`);
const manrope = (w: number) =>
  path.join(FP, 'manrope', 'files', `manrope-latin-${w}-normal.woff`);

Font.register({
  family: 'DM Sans',
  fonts: [
    { src: dmSans(400), fontWeight: 400 },
    { src: dmSans(500), fontWeight: 500 },
    { src: dmSans(600), fontWeight: 600 },
    { src: dmSans(700), fontWeight: 700 },
  ],
});

Font.register({
  family: 'Manrope',
  fonts: [
    { src: manrope(600), fontWeight: 600 },
    { src: manrope(700), fontWeight: 700 },
    { src: manrope(800), fontWeight: 800 },
  ],
});

const C = {
  gray12: '#202020',
  gray11: '#646464',
  gray6: '#D9D9D9',
  gray2: '#F9F9F9',
  gray1: '#FCFCFC',
  green3: '#DAF1DB',
  green12: '#203C25',
  blue3: '#DEF7F9',
  blue12: '#0D3C48',
  white: '#FFFFFF',
} as const;

// Fuso de Brasília (UTC-3 fixo desde 2019). Usado para INSTANTES REAIS (emissão).
// O servidor roda em UTC em produção → `getHours()` cravaria UTC; formatamos
// explicitamente no fuso de Brasília.
const TZ_BR = 'America/Sao_Paulo';

/** Data do EVENTO: wall-clock "naive" (sem fuso) → UTC pra não deslocar o dia. */
function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const dt = new Date(d as string);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

/** Data+hora de um INSTANTE REAL (emissão) no fuso de Brasília. */
function fmtDateTime(d: Date): string {
  const date = d.toLocaleDateString('pt-BR', { timeZone: TZ_BR });
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ_BR,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${date} · ${hh}h${mm}`;
}

function fmtCPF(cpf: string): string {
  const d = cpf.replace(/\D/g, '');
  if (d.length !== 11) return cpf;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/* Registra TODOS os 77 locales no `i18n-iso-countries` (idempotente).
 * Memoizado fora das funcoes pra rodar so uma vez por processo. */
let localesRegistered = false;
function ensureLocales() {
  if (localesRegistered) return;
  for (const locale of ALL_LOCALES) {
    try {
      (countries as any).registerLocale(locale);
    } catch {
      // ignora: locale pode lancar em re-registro
    }
  }
  localesRegistered = true;
}

/* Overrides manuais pra nomes PT-BR que `i18n-iso-countries` nao resolve
 * (lib usa nomenclatura PT-PT em algumas entradas). Sincronizado com o
 * `PT_BR_ALIASES` do frontend (`src/utils/phone.ts`). */
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

/**
 * Resolve nome do país para código ISO 3166-1 alpha-2.
 *
 * Ordem de resolucao:
 *   1. country null/vazio → 'BR' (default historico).
 *   2. Override manual em PT_BR_ALIASES.
 *   3. `i18n-iso-countries.getAlpha2Code` em PT.
 *   4. Mesma lib em EN.
 *   5. null (pais nao identificado).
 *
 * Aceita tanto codigo ISO direto ("BR", "AR") quanto nome em portugues ou
 * ingles ("Brasil", "Argentina", "United States").
 */
/**
 * Cache memoizado pra evitar varrer locales em cada chamada (overhead de
 * lookup por string). Vive enquanto o processo Node estiver up. */
const isoLookupCache = new Map<string, CountryCode | null>();

function getISOFromCountry(country?: string | null): CountryCode | null {
  if (!country || !country.trim()) return 'BR';
  ensureLocales();
  const key = country.trim();
  if (isoLookupCache.has(key)) return isoLookupCache.get(key) as CountryCode | null;

  const lowered = key.toLowerCase();
  let code: string | undefined;

  // 1) Override manual PT-BR pros nomes que a lib resolve em PT-PT.
  if (PT_BR_ALIASES[lowered]) {
    code = PT_BR_ALIASES[lowered];
  }

  // 2) Lookup em TODOS os 77 locales registrados (case + lower) ate achar.
  if (!code) {
    for (const locale of SUPPORTED_LOCALE_CODES) {
      code = (countries as any).getAlpha2Code(key, locale) as string | undefined;
      if (code) break;
      code = (countries as any).getAlpha2Code(lowered, locale) as string | undefined;
      if (code) break;
    }
  }

  // 3) Aceita codigo ISO-3166 alpha-2 cru ("BR", "AR", "us", "GB").
  if (!code && /^[a-zA-Z]{2}$/.test(key)) {
    const upper = key.toUpperCase();
    if ((countries as any).isValid(upper)) code = upper;
  }

  // 4) Aceita codigo ISO-3166 alpha-3 ("BRA", "USA") via alpha3ToAlpha2.
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
 * Prioridade (mais autoritativo → menos autoritativo):
 *   1. `documentType === 'PASSPORT'` → forca nao-brasileiro (sinal explicito).
 *   2. Shape do doc indica passaporte (contem letras) → nao-brasileiro.
 *      Cobre o caso de cadastros antigos onde documentType estava CPF default
 *      mas o numero salvo tem letras (estrangeiro).
 *   3. ISO do `country` mapeado para outro pais → nao-brasileiro.
 *   4. ISO resolvido para 'BR' → brasileiro.
 *   5. country null/vazio + doc nao tem letras + sem documentType PASSPORT
 *      → assume BR (default historico).
 */
function isBR(
  country?: string | null,
  documentType?: 'CPF' | 'PASSPORT' | null,
  doc?: string | null,
): boolean {
  if (documentType === 'PASSPORT') return false;
  if (doc && /[A-Za-z]/.test(doc)) return false;
  const iso = getISOFromCountry(country);
  if (iso === 'BR') return true;
  if (iso !== null) return false;
  /* country null + sem PASSPORT/letras: cai em documentType. Cadastros
   * brasileiros legados tem documentType=CPF default. */
  return documentType === 'CPF';
}

/**
 * Formata telefone conforme país usando `libphonenumber-js` AsYouType.
 *
 * Quando o documento e PASSPORT (estrangeiro) mas o pais e desconhecido,
 * retorna so digitos limpos pra evitar mascara BR errada. Pra paises
 * mapeados, AsYouType cuida da formatacao nativa.
 */
function fmtPhone(
  phone: string,
  country?: string | null,
  documentType?: 'CPF' | 'PASSPORT' | null,
  doc?: string | null,
): string {
  if (!phone) return phone;
  const digits = phone.replace(/\D/g, '');
  /* Resolve ISO via country. PASSPORT importa so pro fallback isBR
   * (cadastros legados sem country). */
  let iso = getISOFromCountry(country);
  if (!iso && isBR(country, documentType, doc)) {
    iso = 'BR';
  }
  if (iso) {
    try {
      /* parse → formatNational. Reconhece numeros nacionais validos.
       * Invalido → digitos crus (nao best-effort errado). */
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
 * Valida a fonte da imagem antes de passar ao renderer do PDF.
 * Previne SSRF: @react-pdf/renderer usa fetch nativo que pode acessar file:///,
 * http://localhost etc. se URLs arbitrárias forem aceitas sem validação.
 *
 * Aceita:
 *  - `https://` — URL externa (o renderer faz o fetch);
 *  - `data:image/` — imagem JÁ pré-processada server-side (via buildPdfImageDataUri,
 *    WebP→PNG): o renderer NÃO faz fetch, então não há vetor de SSRF.
 */
function safeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (/^https:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)) return trimmed;
  return null;
}

const HR = () =>
  React.createElement(View, { style: { height: 1, backgroundColor: C.gray6 } });

const e = React.createElement;

/* Tokens de tipografia do Figma (node 6512:127745). Manrope p/ títulos,
 * DM Sans p/ corpo. `lineHeight` é multiplicador no react-pdf. */
const T = {
  h24: { fontFamily: 'Manrope', fontWeight: 700, fontSize: 24, lineHeight: 1.1, color: C.gray12 },
  h20: { fontFamily: 'Manrope', fontWeight: 600, fontSize: 20, lineHeight: 1.1, color: C.gray12 },
  h18b: { fontFamily: 'Manrope', fontWeight: 700, fontSize: 18, lineHeight: 1.1, color: C.gray12 },
  h18: { fontFamily: 'Manrope', fontWeight: 600, fontSize: 18, lineHeight: 1.1, color: C.gray12 },
  h16: { fontFamily: 'Manrope', fontWeight: 600, fontSize: 16, lineHeight: 1.1, color: C.gray12 },
  label: { fontFamily: 'DM Sans', fontWeight: 400, fontSize: 16, lineHeight: 1.3, color: C.gray11 },
  labelDark: { fontFamily: 'DM Sans', fontWeight: 400, fontSize: 16, lineHeight: 1.3, color: C.gray12 },
  med20: { fontFamily: 'DM Sans', fontWeight: 500, fontSize: 20, lineHeight: 1.3, color: C.gray12 },
  med18: { fontFamily: 'DM Sans', fontWeight: 500, fontSize: 18, lineHeight: 1.3, color: C.gray12 },
  med16: { fontFamily: 'DM Sans', fontWeight: 500, fontSize: 16, lineHeight: 1.3, color: C.gray12 },
  sb16: { fontFamily: 'DM Sans', fontWeight: 600, fontSize: 16, lineHeight: 1.3, color: C.gray12 },
};

/* Campo label + valor.
 *  - `dark`   → label em gray12 (bloco do participante); senão gray11 (evento/perguntas).
 *  - `strong` → valor em Manrope SemiBold 18 (participante/evento); senão DM Sans Medium 16 (perguntas). */
const InfoField = ({
  label,
  value,
  dark,
  strong,
  py = 0,
  gap = 12,
}: {
  label: string;
  value: string;
  dark?: boolean;
  strong?: boolean;
  py?: number;
  gap?: number;
}) =>
  e(
    View,
    { style: { gap, minWidth: 0, paddingVertical: py } },
    e(Text, { style: dark ? T.labelDark : T.label }, label),
    e(Text, { style: strong ? T.h18 : T.med16 }, value || '—'),
  );

/* Distribui itens em linhas de 2 colunas (flex 1 cada). `fillLast` insere um
 * espaçador quando a última linha tem 1 item — mantém-o com meia largura
 * (usado em campos/perguntas; produtos ocupam a linha inteira quando sozinhos). */
function twoCol(
  items: any[],
  render: (it: any, i: number) => any,
  opts?: { rowGap?: number; colGap?: number; fillLast?: boolean },
) {
  const rowGap = opts?.rowGap ?? 0;
  const colGap = opts?.colGap ?? 12;
  const rows: any[] = [];
  for (let i = 0; i < items.length; i += 2) {
    const pair = items.slice(i, i + 2);
    const cells: any[] = pair.map((it, j) =>
      e(View, { key: j, style: { flex: 1, minWidth: 0 } }, render(it, i + j)),
    );
    if (pair.length === 1 && opts?.fillLast) {
      cells.push(e(View, { key: 'spacer', style: { flex: 1 } }));
    }
    rows.push(e(View, { key: i, style: { flexDirection: 'row', gap: colGap } }, ...cells));
  }
  return e(View, { style: { gap: rowGap } }, ...rows);
}

/* Ícone de bandeira (chip "Evento") — outline verde sobre fundo green3. */
const FlagIcon = () =>
  e(
    Svg,
    { width: 24, height: 24, viewBox: '0 0 24 24' },
    e(Path, {
      d: 'M6 21V4 M6 5h11l-2.5 3.5L17 12H6',
      stroke: C.green12,
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      fill: 'none',
    }),
  );

/* Rótulo de modalidade (Ticket.modality) → arquivo PNG do ícone 3D em
 * `common/assets/modalities/`. Mesmos ícones do frontend (`modalitiesColumns`).
 * PNGs pré-convertidos de webp (scripts/convert-modality-icons.ts) — o
 * @react-pdf NÃO decodifica webp e a conversão em runtime é frágil. */
const MODALITY_ICON_FILES: Record<string, string> = {
  corrida: 'Icon3D-corrida-de-rua.png',
  natacao: 'Icon3D-natacao.png',
  ciclismo: 'Icon3D-ciclismo.png',
  triathlon: 'Icon-3D-Triathlon.png',
  outros: 'Icon3D-outros.png',
};

// Memoiza o data-URI por arquivo — 5 PNGs estáticos, lidos 1× por processo.
const modalityIconCache = new Map<string, string | null>();

/* Ícone 3D da modalidade como data-URI PNG, a partir do campo combinado
 * `modality` ("Corrida 5 KM"): a distância começa por dígito, então cortamos a
 * partir do 1º número e sobra o rótulo ("Corrida"). Só-distância ("0.3 Km") →
 * null (sem ícone). Rótulo desconhecido → "outros".
 *
 * Embute como data-URI (lê o PNG pré-convertido com `fs`) em vez de passar o
 * caminho local ao <Image>: o @react-pdf rejeita paths locais ("Only absolute
 * URLs are supported"), mas aceita data-URI de forma portável. PNG já pronto →
 * sem `sharp`/webp em runtime. */
function modalityIconDataUri(modality?: string | null): string | null {
  if (!modality) return null;
  const label = modality.replace(/\s*\d.*$/, '').trim();
  if (!label) return null;
  const key = label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const file = MODALITY_ICON_FILES[key] ?? MODALITY_ICON_FILES.outros;
  if (modalityIconCache.has(file)) return modalityIconCache.get(file) ?? null;
  try {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'assets', 'modalities', file));
    const uri = `data:image/png;base64,${buf.toString('base64')}`;
    modalityIconCache.set(file, uri);
    return uri;
  } catch {
    modalityIconCache.set(file, null); // fail-open: sem ícone, nunca quebra o PDF
    return null;
  }
}

/* Logo do cabeçalho como data-URI PNG (lido com `fs`, memoizado 1×/processo).
 * O @react-pdf REJEITA caminho de arquivo local no <Image> ("Only absolute URLs
 * are supported") — mesma restrição dos ícones de modalidade. Embutir como
 * data-URI garante o logo em qualquer ambiente. Fail-open → null (sem logo). */
let logoUriCache: string | null | undefined;
function logoDataUri(): string | null {
  if (logoUriCache !== undefined) return logoUriCache;
  try {
    const buf = fs.readFileSync(
      path.join(__dirname, '..', 'assets', 'logo-podioticket.png'),
    );
    logoUriCache = `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    logoUriCache = null;
  }
  return logoUriCache;
}

/* Card-resumo do evento: chip verde + nome + 4 campos (2 por linha). */
const EventCard = ({ event }: { event: TicketPdfTemplateData['event'] }) =>
  e(
    View,
    {
      style: {
        borderWidth: 1,
        borderColor: C.gray6,
        borderStyle: 'solid',
        borderRadius: 8,
        padding: 16,
        gap: 20,
        width: '100%',
      },
    },
    e(
      View,
      { style: { flexDirection: 'row', alignItems: 'center', gap: 12 } },
      e(
        View,
        {
          style: {
            backgroundColor: C.green3,
            borderRadius: 8,
            padding: 8,
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
        e(FlagIcon, null),
      ),
      e(
        View,
        { style: { gap: 8, minWidth: 0 } },
        e(Text, { style: T.label }, 'Evento'),
        e(Text, { style: T.h18b }, event.name || '—'),
      ),
    ),
    e(HR, null),
    twoCol(
      [
        { label: 'Data', value: fmtDate(event.date) },
        { label: 'Organização', value: event.organization },
        { label: 'Local do evento', value: event.location },
        {
          label: 'Participantes',
          value: `${event.participantCount} atleta${event.participantCount !== 1 ? 's' : ''}`,
        },
      ],
      (f: { label: string; value: string }) =>
        e(InfoField, { label: f.label, value: f.value, strong: true }),
      { rowGap: 24, colGap: 12 },
    ),
  );

/* Bloco "Ingresso": categoria + nome + modalidade (esquerda) e QR (direita). */
const IngressoSection = ({ reg }: { reg: TicketPdfRegistrationWithQr }) =>
  e(
    View,
    {
      style: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 16,
        width: '100%',
      },
    },
    /* Esquerda */
    e(
      View,
      { style: { flex: 1, minWidth: 0, gap: 24 } },
      e(Text, { style: T.h20 }, 'Ingresso'),
      e(
        View,
        { style: { gap: 20 } },
        e(
          View,
          { style: { gap: 8 } },
          e(Text, { style: T.label }, reg.ticketCategory || 'Ingresso avulso'),
          e(Text, { style: T.med20 }, reg.ticketName || '—'),
        ),
        reg.modality && String(reg.modality).trim()
          ? e(
              View,
              { style: { flexDirection: 'row', gap: 8, alignItems: 'center' } },
              // Ícone 3D da modalidade (data-URI PNG, mesmos do frontend); ausente → só o texto.
              modalityIconDataUri(reg.modality)
                ? e(Image, {
                    src: modalityIconDataUri(reg.modality) as string,
                    style: { width: 24, height: 24 },
                  })
                : null,
              e(Text, { style: T.med18 }, String(reg.modality).trim()),
            )
          : null,
      ),
    ),
    /* Direita: QR em caixa gray2 */
    e(
      View,
      { style: { flexShrink: 0 } },
      e(
        View,
        {
          style: {
            backgroundColor: C.gray2,
            borderWidth: 1,
            borderColor: C.gray6,
            borderStyle: 'solid',
            borderRadius: 8,
            padding: 8,
          },
        },
        e(Image, { src: reg.qrDataUrl, style: { width: 100, height: 100 } }),
      ),
    ),
  );

/* Card de produto (Figma): imagem 100×100 + nome + "Tamanho: X" à direita.
 * Sem preço nem badge Incluso/Adicional (decisão de produto: igual ao design).
 *
 * IMPORTANTE: NÃO usar `flex: 1` aqui. A célula do `twoCol` é uma COLUNA, então
 * `flex: 1` (= flexBasis 0) COLAPSA a ALTURA do card e a imagem de 100px vaza
 * pra fora. A largura das 2 colunas já vem do `flex: 1` da CÉLULA; o card só
 * estica na largura (cross-axis da coluna = `stretch` por padrão) e tem
 * ALTURA = conteúdo. `width: '100%'` garante a largura cheia. */
const ProductCard = ({ product }: { product: TicketPdfProduct }) =>
  e(
    View,
    {
      style: {
        width: '100%',
        minWidth: 0,
        flexDirection: 'row',
        gap: 12,
        alignItems: 'center',
        padding: 12,
        borderWidth: 1,
        borderColor: C.gray6,
        borderStyle: 'solid',
        borderRadius: 8,
      },
    },
    /* Imagem 100×100 — safeImageUrl valida https:// para prevenir SSRF.
     * A <Image> fica DENTRO de um box fixo com `overflow: hidden`: no
     * @react-pdf o `objectFit: cover` numa Image de proporção != 1:1 não
     * recorta de forma confiável e a imagem vaza pra fora do card. O wrapper
     * de tamanho fixo (com borda/raio) faz o clip; a Image preenche 100%.
     * `flexShrink: 0` impede que a linha flex esprema o box. */
    e(
      View,
      {
        style: {
          width: 100,
          height: 100,
          flexShrink: 0,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: C.gray6,
          borderStyle: 'solid',
          backgroundColor: C.gray6,
          overflow: 'hidden',
        },
      },
      safeImageUrl(product.imageUrl)
        ? e(Image, {
            src: safeImageUrl(product.imageUrl) as string,
            style: { width: '100%', height: '100%', objectFit: 'cover' },
          })
        : null,
    ),
    e(
      View,
      {
        style: {
          flex: 1,
          minWidth: 0,
          alignSelf: 'stretch',
          justifyContent: 'space-between',
          paddingVertical: 8,
          gap: 12,
        },
      },
      e(Text, { style: T.sb16 }, product.name),
      product.variationName
        ? e(
            View,
            {
              style: {
                flexDirection: 'row',
                gap: 4,
                alignItems: 'center',
                justifyContent: 'flex-end',
              },
            },
            e(Text, { style: T.labelDark }, 'Tamanho: '),
            e(Text, { style: T.h16 }, product.variationName),
          )
        : null,
    ),
  );

/* Rótulo humano do sexo. O valor persistido pode vir em maiúsculas OU minúsculas
   (ex.: "OTHER"/"other", "PREFER_NOT_TO_SAY") — normaliza p/ o mapa; valor
   desconhecido cai no cru (nunca fica vazio). Espelha o `getGenderLabel` do front. */
const GENDER_LABELS: Record<string, string> = {
  MALE: 'Masculino',
  FEMALE: 'Feminino',
  OTHER: 'Outro',
  PREFER_NOT_TO_SAY: 'Prefiro não dizer',
};
const fmtGender = (g: string): string => GENDER_LABELS[g.toUpperCase()] ?? g;

/* Card único do participante (Figma 6512:128371): seções Ingresso →
 * Informações do participante → Produtos do kit → Perguntas do Organizador,
 * separadas por dividers. `wrap: false` evita quebra do card entre páginas. */
const ParticipantCard = ({ reg }: { reg: TicketPdfRegistrationWithQr }) => {
  // Ordem/labels do design. "Nome" agora é campo (não cabeçalho separado).
  const infoFields = [
    { label: 'Nome', value: reg.participantName },
    reg.dateOfBirth ? { label: 'Data de nascimento', value: fmtDate(reg.dateOfBirth) } : null,
    reg.gender ? { label: 'Sexo', value: fmtGender(reg.gender) } : null,
    reg.cpf
      ? isBR(reg.country, reg.documentType, reg.cpf)
        ? { label: 'CPF', value: fmtCPF(reg.cpf) }
        : { label: 'Documento', value: reg.cpf }
      : null,
    reg.email ? { label: 'Email', value: reg.email } : null,
    reg.phone ? { label: 'Telefone', value: fmtPhone(reg.phone, reg.country, reg.documentType, reg.cpf) } : null,
  ].filter(Boolean) as { label: string; value: string }[];

  // Seções presentes, na ordem do design.
  const sections: any[] = [];

  sections.push(e(IngressoSection, { reg }));

  sections.push(
    e(
      View,
      { style: { gap: 16, width: '100%' } },
      e(Text, { style: T.h20 }, 'Informações do participante'),
      twoCol(
        infoFields,
        (f: { label: string; value: string }) =>
          e(InfoField, { label: f.label, value: f.value, dark: true, strong: true, py: 16, gap: 15 }),
        { rowGap: 0, colGap: 8 },
      ),
    ),
  );

  if (reg.products.length > 0) {
    sections.push(
      e(
        View,
        { style: { gap: 16, width: '100%' } },
        e(Text, { style: T.h20 }, 'Produtos do kit'),
        // Coluna ÚNICA: 1 produto por linha (full-width). Em 2 colunas o card
        // quebrava (largura insuficiente p/ imagem 100 + nome + tamanho).
        e(
          View,
          { style: { gap: 16, width: '100%' } },
          ...reg.products.map((p: TicketPdfProduct, i: number) =>
            e(ProductCard, { key: i, product: p }),
          ),
        ),
      ),
    );
  }

  if (reg.questionAnswers.length > 0) {
    sections.push(
      e(
        View,
        { style: { gap: 12, width: '100%' } },
        e(Text, { style: T.h18 }, 'Perguntas do Organizador'),
        twoCol(
          reg.questionAnswers,
          (qa: { question: string; answer: string }) =>
            e(InfoField, { label: qa.question, value: qa.answer, py: 16, gap: 15 }),
          { rowGap: 0, colGap: 8, fillLast: true },
        ),
      ),
    );
  }

  // Intercala divisórias entre as seções presentes.
  const children: any[] = [];
  sections.forEach((s, i) => {
    if (i > 0) children.push(e(HR, { key: `hr-${i}` }));
    children.push(e(View, { key: `s-${i}`, style: { width: '100%' } }, s));
  });

  return e(
    View,
    {
      wrap: false,
      style: {
        borderWidth: 1,
        borderColor: C.gray6,
        borderStyle: 'solid',
        borderRadius: 8,
        padding: 20,
        gap: 32,
        width: '100%',
      },
    },
    ...children,
  );
};

const LogoVector = () =>
  React.createElement(
    Svg,
    { width: 29, height: 28, viewBox: '0 0 29 28' },
    React.createElement(
      Defs,
      null,
      React.createElement(
        LinearGradient,
        {
          id: 'lgrad',
          x1: '22.5514',
          y1: '-1.14754',
          x2: '0.808587',
          y2: '28.4166',
          gradientUnits: 'userSpaceOnUse',
        },
        React.createElement(Stop, { offset: '0', stopColor: '#57D321' }),
        React.createElement(Stop, { offset: '0.523222', stopColor: '#1CB757' }),
        React.createElement(Stop, { offset: '1', stopColor: '#18773D' }),
      ),
    ),
    React.createElement(Path, {
      d: 'M28.023 12.4933C27.1431 11.4496 25.8464 10.8458 24.482 10.8458H18.8104C18.1477 10.8458 17.5122 11.1017 17.0364 11.5617L0 28L6.70384 11.0729C6.96406 10.4145 7.60094 9.98316 8.30828 9.98316H15.1156C15.8833 9.98316 16.4656 9.35346 16.4656 8.63463C16.4656 8.5038 16.4469 7.07476 16.4067 6.94249C16.2327 6.37462 15.7079 5.98788 15.1156 5.98788H7.60813C7.06757 5.98788 6.55864 5.73485 6.23229 5.30499L1.22921 0H17.1571C17.1974 0 17.2376 0.00143767 17.2779 0.004313C17.2836 0.004313 17.2908 0.004313 17.298 0.00575067C17.9981 0.0632573 18.5991 0.539125 18.8076 1.21914L19.2432 2.64243C19.4114 3.18875 19.9146 3.56254 20.4868 3.56254H25.6854C26.4444 3.56254 27.1144 4.0571 27.3358 4.78312L28.6009 8.91497C28.9733 10.1327 28.7605 11.4539 28.023 12.4933Z',
      fill: 'url(#lgrad)',
    }),
  );

const PodioBrand = () =>
  React.createElement(
    Svg,
    { width: 60, height: 18, viewBox: '0 0 60 19' },
    React.createElement(Path, {
      d: 'M19.7389 5.00534C21.0148 5.00535 22.1414 5.29011 23.1078 5.8702C24.0692 6.44729 24.8164 7.24686 25.3468 8.26266C25.8783 9.273 26.1397 10.4298 26.1397 11.725C26.1397 13.0281 25.8745 14.1927 25.3352 15.2107L25.3351 15.2105C24.8044 16.2189 24.0573 17.0143 23.0965 17.5911L23.0949 17.592C22.129 18.1638 21.0069 18.4446 19.7389 18.4446C18.4701 18.4446 17.3473 18.1597 16.3811 17.5798C15.4201 17.0029 14.6728 16.2073 14.1421 15.1986L14.1415 15.1973L14.1408 15.1962C13.6178 14.1792 13.3605 13.0196 13.3605 11.725C13.3605 10.4076 13.6256 9.23867 14.1656 8.22726C14.7039 7.21913 15.4551 6.42731 16.4167 5.85801C17.3817 5.28666 18.4924 5.00534 19.7389 5.00534ZM39.2123 18.4576H36.2063V17.5318C35.3186 18.1512 34.2557 18.4446 33.0151 18.4446C31.8382 18.4446 30.7977 18.149 29.9052 17.549C29.0201 16.954 28.3367 16.1455 27.8548 15.1315C27.3729 14.1175 27.1351 12.9801 27.1351 11.725C27.1351 10.4555 27.3726 9.31384 27.8551 8.30648L27.8555 8.30561C28.3458 7.29072 29.0417 6.48574 29.9427 5.89864C30.8502 5.29985 31.9123 5.00534 33.1171 5.00534C34.1687 5.00534 35.0891 5.22715 35.8664 5.68202V0H39.2123V18.4576ZM53.3875 5.00534C54.6634 5.00534 55.7899 5.29011 56.7564 5.8702C57.7178 6.4473 58.4651 7.24684 58.9955 8.26266L59.0445 8.35784C59.5431 9.34546 59.7885 10.4703 59.7885 11.725C59.7885 13.0281 59.5231 14.1927 58.9838 15.2107L58.9836 15.2105C58.453 16.2189 57.7059 17.0143 56.745 17.5911L56.7436 17.592C55.7777 18.1638 54.6555 18.4446 53.3875 18.4446C52.1187 18.4446 50.996 18.1597 50.0299 17.5798C49.0688 17.0029 48.3213 16.2073 47.7907 15.1986L47.7901 15.1973L47.7895 15.1962C47.2666 14.1792 47.0091 13.0196 47.0091 11.725C47.0091 10.4076 47.2743 9.23868 47.8143 8.22726C48.3526 7.21913 49.1038 6.42731 50.0654 5.85801C51.0304 5.28668 52.141 5.00534 53.3875 5.00534ZM7.03517 0C7.20085 0 7.40944 0.00764142 7.65919 0.0226334C7.91622 0.0305294 8.15725 0.0540047 8.38166 0.0934353C9.36399 0.241995 10.1925 0.569408 10.8524 1.08771C11.5127 1.60048 12.0011 2.25094 12.315 3.03403L12.3728 3.17912C12.6528 3.90979 12.7905 5.99888 12.7906 6.86868C12.7906 7.78936 12.6337 8.63956 12.3154 9.41537L12.315 9.41638C11.9936 10.1918 11.5017 10.8377 10.8424 11.3501C10.1827 11.8687 9.35808 12.1967 8.38224 12.3455L8.3792 12.346C8.1584 12.3773 7.9162 12.4005 7.65311 12.4159C7.40137 12.4311 7.19467 12.4391 7.03517 12.4391H3.32309V18.4446H0V0H7.03517ZM45.1167 18.4446H41.7936V4.78252H45.1167V18.4446ZM33.5248 8.03343C32.8421 8.03343 32.3053 8.20072 31.8921 8.51395C31.4646 8.8314 31.1464 9.26313 30.9379 9.82306L30.9375 9.82422C30.7253 10.3871 30.6168 11.0195 30.6168 11.725C30.6168 12.4376 30.7214 13.0776 30.9262 13.6482L30.9665 13.7508C31.1746 14.2563 31.4732 14.6521 31.8594 14.9482C32.2574 15.2533 32.7748 15.4166 33.4341 15.4166C34.1231 15.4166 34.6439 15.2613 35.0239 14.9793C35.4226 14.6815 35.718 14.2649 35.9049 13.714L35.906 13.7108C36.0916 13.1833 36.193 12.57 36.205 11.8669L36.2063 11.725L36.205 11.5818C36.193 10.8722 36.0914 10.2598 35.9063 9.74022C35.7171 9.18246 35.4279 8.76983 35.0447 8.48058C34.6682 8.18999 34.1708 8.03343 33.5248 8.03343ZM19.7389 8.14616C19.051 8.14616 18.5104 8.30101 18.0962 8.58882C17.6815 8.87502 17.3692 9.27908 17.1619 9.81537L17.1615 9.81653C16.9512 10.3534 16.8422 10.9875 16.8422 11.725C16.8422 12.8604 17.1001 13.7332 17.5854 14.3728C18.0619 14.9838 18.7631 15.304 19.7389 15.304C20.7545 15.304 21.4628 14.9716 21.923 14.3436C22.4049 13.686 22.6582 12.8211 22.6582 11.725C22.6582 10.5891 22.4001 9.72061 21.9156 9.08907C21.4466 8.47157 20.7399 8.14617 19.7389 8.14616ZM53.3875 8.14616C52.6996 8.14616 52.1591 8.30102 51.7449 8.58882C51.3301 8.87502 51.0179 9.27908 50.8106 9.81537L50.81 9.81653C50.5998 10.3534 50.4908 10.9875 50.4908 11.725C50.4908 12.8603 50.7486 13.7331 51.2338 14.3727C51.7104 14.9838 52.4116 15.304 53.3875 15.304C54.4031 15.304 55.1113 14.9716 55.5715 14.3436C56.0535 13.686 56.3068 12.8211 56.3068 11.725C56.3068 10.589 56.0487 9.72061 55.5641 9.08907C55.0952 8.47156 54.3885 8.14616 53.3875 8.14616ZM3.32309 9.3096H6.92194C7.06339 9.3096 7.22519 9.30253 7.40793 9.28798C7.58 9.27429 7.73411 9.24719 7.87131 9.20819C8.28892 9.10422 8.58716 8.93066 8.79632 8.69807C9.03325 8.44191 9.19465 8.15911 9.28696 7.84424C9.39358 7.50431 9.44485 7.1813 9.44485 6.86868C9.44484 6.55606 9.39358 4.94596 9.28855 4.61155C9.19387 4.28194 9.03226 3.99598 8.79908 3.74408C8.58716 3.5083 8.28891 3.33488 7.88088 3.23338C7.73836 3.19312 7.58829 3.16972 7.41968 3.16301C7.22519 3.14774 7.06339 3.14082 6.92194 3.14082H3.32309V9.3096ZM21.0123 4.19127H18.2961L20.2887 0.0129956H23.0048L21.0123 4.19127ZM45.1167 3.15379H41.7936V0.0694119H45.1167V3.15379Z',
      fill: '#202020',
    }),
  );

const TicketBrand = () =>
  React.createElement(
    Svg,
    { width: 70, height: 18, viewBox: '0 0 70 19' },
    React.createElement(Path, {
      d: 'M5.96792 18.4138L6.06698 2.26953H0V0.0126195H14.3334V2.26953H8.26642L8.16736 18.4138H5.96792Z',
      fill: '#202020',
    }),
    React.createElement(Path, {
      d: 'M16.3007 2.39514V0.0126195H18.5001V2.39514H16.3007ZM16.2017 18.4138L16.3007 4.74685H18.5001L18.4011 18.4138H16.2017Z',
      fill: '#202020',
    }),
    React.createElement(Path, {
      d: 'M27.5826 18.4138C26.2317 18.4138 25.0825 18.1142 24.1352 17.515C23.1961 16.9076 22.4794 16.0744 21.9852 15.0155C21.4909 13.9567 21.2356 12.75 21.2191 11.3956C21.2356 10.0084 21.4951 8.78948 21.9975 7.7388C22.5083 6.67992 23.2373 5.85498 24.1846 5.26397C25.1319 4.67297 26.2729 4.37747 27.6073 4.37747C29.016 4.37747 30.2269 4.72222 31.2401 5.41173C32.2616 6.10123 32.9453 7.0452 33.2913 8.24362L31.1166 8.89619C30.8365 8.1246 30.3793 7.52539 29.745 7.09855C29.1189 6.67171 28.3982 6.4583 27.5826 6.4583C26.6683 6.4583 25.9145 6.67171 25.3214 7.09855C24.7283 7.51718 24.2876 8.09997 23.9993 8.84694C23.711 9.58569 23.5627 10.4353 23.5545 11.3956C23.5709 12.8732 23.9128 14.0675 24.58 14.9786C25.2555 15.8815 26.2564 16.333 27.5826 16.333C28.4558 16.333 29.1807 16.136 29.7574 15.742C30.334 15.3398 30.7706 14.7611 31.0671 14.0059L33.2913 14.5846C32.83 15.8241 32.1092 16.7721 31.1289 17.4288C30.1486 18.0855 28.9665 18.4138 27.5826 18.4138Z',
      fill: '#202020',
    }),
    React.createElement(Path, {
      d: 'M35.5536 18.4138L35.566 0.0126195H37.7902V11.1494L43.3876 4.74685H46.2419L40.3479 11.3956L47.1471 18.4138H44.0704L37.7902 11.6419V18.4138H35.5536Z',
      fill: '#202020',
    }),
    React.createElement(Path, {
      d: 'M53.458 18.4138C52.1483 18.4138 51.0032 18.1265 50.023 17.5519C49.0509 16.9691 48.2931 16.1606 47.7494 15.1264C47.2057 14.0839 46.9339 12.869 46.9339 11.4818C46.9339 10.0289 47.2016 8.77306 47.737 7.71418C48.2725 6.64709 49.018 5.82625 49.9735 5.25166C50.9373 4.66887 52.0659 4.37747 53.3592 4.37747C54.7019 4.37747 55.8428 4.68528 56.7819 5.30091C57.7292 5.91654 58.4377 6.79484 58.9072 7.93581C59.385 9.07677 59.5909 10.4353 59.525 12.0113H57.3009V11.2233C57.2762 9.5898 56.9426 8.37085 56.3 7.56643C55.6575 6.7538 54.7019 6.34748 53.4333 6.34748C52.0741 6.34748 51.0403 6.78253 50.3319 7.65262C49.6234 8.52271 49.2692 9.77038 49.2692 11.3956C49.2692 12.9634 49.6234 14.1783 50.3319 15.0402C51.0403 15.9021 52.0494 16.333 53.3592 16.333C54.2406 16.333 55.0067 16.1319 55.6575 15.742C56.3083 15.3275 56.819 14.7488 57.1897 13.9936L59.3026 14.72C58.7836 15.8938 58.0011 16.805 56.9549 17.4534C55.917 18.0937 54.7514 18.4138 53.458 18.4138ZM48.5278 12.0113V10.2506H58.3882V12.0113H48.5278Z',
      fill: '#202020',
    }),
    React.createElement(Path, {
      d: 'M69.4798 18.1919C68.689 18.3479 67.9064 18.4094 67.1321 18.3766C66.366 18.352 65.6823 18.2001 65.081 17.921C64.4796 17.6337 64.0224 17.043 63.7094 16.4438C63.4458 15.9185 63.3016 15.389 63.2769 14.8555C63.2604 14.3137 63.2522 13.7022 63.2522 13.0209V0H65.4516V12.9224C65.4516 13.4642 65.4558 13.9279 65.464 14.3137C65.4805 14.6995 65.567 15.032 65.7235 15.311C66.02 15.8364 66.4896 16.1442 67.1321 16.2345C67.7829 16.3248 68.5655 16.3002 69.4798 16.1606V18.1919ZM60.5462 6.5568V4.74685H69.4798V6.5568H60.5462Z',
      fill: '#202020',
    }),
  );

/* Altura aproximada da página única (scroll infinito). Superestima de
 * propósito (buffer generoso) — sobra vira espaço em branco no rodapé, o que é
 * preferível a cortar conteúdo. Escala com nº de campos/produtos/perguntas. */
/* Altura aproximada da PÁGINA ÚNICA. É crítico NUNCA subestimar: como o doc é
 * uma página só (sem quebra), se a altura ficar menor que o conteúdo o @react-pdf
 * empurra o resto pra uma 2ª página e CORTA. Por isso contamos a quebra de linha
 * dos textos longos e superestimamos com folga — o excedente vira branco no
 * rodapé (aceitável), nunca corte. Página maior NUNCA cria 2ª página. */
function estimatePageHeight(data: TicketPdfTemplateData): number {
  // Linhas aproximadas de um texto numa coluna de `colW` px. Fator 0.62 =
  // largura média de caractere ~ fontSize*0.62 (conservador → superestima).
  const lines = (text: string | null | undefined, colW: number, fs: number) => {
    const len = String(text ?? '').length;
    const cpl = Math.max(6, Math.floor(colW / (fs * 0.62)));
    return Math.max(1, Math.ceil(len / cpl));
  };
  // Altura de um campo "label + valor" (InfoField): py(16*2) + gap 15 + linhas.
  const fieldH = (label: string, value: string, colW: number, valFs: number) =>
    32 + 15 + lines(label, colW, 16) * 21 + lines(value, colW, valFs) * (valFs * 1.35);

  let h = 88; // padding vertical da página (44 topo + 44 rodapé)
  h += 58 + 36; // header + gap
  h += 1 + 36; // divisória + gap
  h += 64 + 36; // título + subtítulo + gap

  // ---- Card do evento: chip + nome + divisória + 2 linhas de campos (2-col) ----
  // Inner do card (padding 16): 507-32=475; colGap 12 → cada coluna ~231.
  const evColW = 231;
  const evRow1 = Math.max(
    fieldH('Data', fmtDate(data.event.date), evColW, 18),
    fieldH('Organização', data.event.organization, evColW, 18),
  );
  const evRow2 = Math.max(
    fieldH('Local do evento', data.event.location, evColW, 18),
    fieldH('Participantes', 'x atletas', evColW, 18),
  );
  h += 32 + 44 + 20 + 1 + 20 + evRow1 + evRow2 + 24;
  h += 24; // gap até o 1º participante

  for (const reg of data.registrations) {
    let c = 40; // padding do card (20*2)

    // Ingresso: título + gap + max(QR box 116, coluna esquerda [nome + modalidade]).
    const leftCol = lines(reg.ticketName, 300, 20) * 27 + 24 + (reg.modality ? 24 : 0);
    c += 22 + 24 + Math.max(116, leftCol);

    // Informações do participante (2-col, colGap 8 → coluna ~229).
    const infoColW = 229;
    const infoFields: Array<[string, string]> = [['Nome', reg.participantName]];
    if (reg.dateOfBirth) infoFields.push(['Data de nascimento', '00/00/0000']);
    if (reg.gender) infoFields.push(['Sexo', 'Masculino']);
    if (reg.cpf) infoFields.push(['Documento', reg.cpf]);
    if (reg.email) infoFields.push(['Email', reg.email]);
    if (reg.phone) infoFields.push(['Telefone', reg.phone]);
    c += 32 + 1 + 22 + 16; // gap+divisória + título + gap
    for (let i = 0; i < infoFields.length; i += 2) {
      const a = infoFields[i];
      const b = infoFields[i + 1];
      c += Math.max(
        fieldH(a[0], a[1], infoColW, 18),
        b ? fieldH(b[0], b[1], infoColW, 18) : 0,
      );
    }

    // Produtos (COLUNA ÚNICA). Card = max(img 100, coluna de texto) + padding 24,
    // + gap 16. Coluna de texto ~355 (467 − 12 gap − 100 img).
    if (reg.products.length > 0) {
      c += 32 + 1 + 22 + 16;
      for (const p of reg.products) {
        const textH = lines(p.name, 355, 16) * 22 + 8 + 24;
        c += Math.max(124, textH + 24) + 16;
      }
    }

    // Perguntas (2-col, coluna ~229). Label = pergunta, valor = resposta —
    // ambos podem ser longos (line-aware).
    if (reg.questionAnswers.length > 0) {
      c += 32 + 1 + 20 + 12;
      const qs = reg.questionAnswers;
      for (let i = 0; i < qs.length; i += 2) {
        const a = qs[i];
        const b = qs[i + 1];
        c += Math.max(
          fieldH(a.question, a.answer, 229, 16),
          b ? fieldH(b.question, b.answer, 229, 16) : 0,
        );
      }
    }

    h += c + 24; // altura do card + gap
  }

  // Margem de segurança: +6% + 250px. Superestimar só adiciona branco no rodapé,
  // nunca corta. Teto 14400 = limite físico de página do PDF.
  h = h * 1.06 + 250;
  return Math.min(14400, Math.max(842, h));
}

export const TicketPdfDocument = ({ data }: { data: TicketPdfTemplateData }) => {
  const pageHeight = estimatePageHeight(data);

  return e(
    Document,
    { title: `Ingresso — ${data.event.name}`, author: 'PódioTicket' },
    e(
      Page,
      {
        size: [595, pageHeight],
        style: {
          fontFamily: 'DM Sans',
          backgroundColor: C.gray1,
          paddingHorizontal: 44,
          paddingVertical: 44,
        },
      },
      e(
        View,
        { style: { gap: 36 } },
        /* Cabeçalho: logo + ID/emitido */
        e(
          View,
          {
            style: {
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
            },
          },
          logoDataUri()
            ? e(Image, {
                src: logoDataUri() as string,
                style: { width: 200, height: 34 },
              })
            : e(View, { style: { width: 200, height: 34 } }),
          e(
            View,
            { style: { alignItems: 'flex-end', gap: 16 } },
            e(
              Text,
              null,
              e(Text, { style: T.labelDark }, 'ID da inscrição: '),
              // Só o 1º segmento do UUID (visual), igual aos painéis/e-mails.
              e(
                Text,
                { style: T.h16 },
                `#${String(data.registrations[0]?.registrationId ?? '').slice(0, 8)}`,
              ),
            ),
            e(Text, { style: T.label }, `Emitido em ${fmtDateTime(data.issuedAt)}`),
          ),
        ),
        e(HR, null),
        /* Título da seção */
        e(
          View,
          { style: { gap: 16 } },
          e(Text, { style: T.h24 }, 'Detalhes da inscrição'),
          e(
            Text,
            { style: T.label },
            'Apresente os QR Codes na retirada do kit ou na entrada do evento',
          ),
        ),
        /* Card do evento + cards de participantes */
        e(
          View,
          { style: { gap: 24 } },
          e(EventCard, { event: data.event }),
          ...data.registrations.map((reg) =>
            e(View, { key: reg.index, style: { width: '100%' } }, e(ParticipantCard, { reg })),
          ),
        ),
      ),
    ),
  );
};
