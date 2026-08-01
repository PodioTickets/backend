import * as sharpLib from 'sharp';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

const sharp = (sharpLib as any).default ?? sharpLib;

/** Máximo de saltos de redirect que seguimos manualmente (cada um revalidado). */
const MAX_REDIRECTS = 3;

/** Teto de bytes da imagem remota (anti-DoS de memória). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Teto de pixels que o `sharp` decodifica (anti bomba de descompressão). */
const MAX_INPUT_PIXELS = 24_000_000; // ~24 MP

/** Expande um IPv6 (qualquer forma, incl. `::` e IPv4 embutido) em 16 bytes; null se inválido. */
function ipv6ToBytes(input: string): number[] | null {
  let addr = input.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  // IPv4 embutido em forma pontuada (`…:1.2.3.4`) → converte o final em 2 hextets.
  const dotted = addr.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const v4 = dotted[2].split('.').map(Number);
    if (v4.some((n) => Number.isNaN(n) || n > 255)) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    addr = `${dotted[1]}${hi}:${lo}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups =
    halves.length === 2
      ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
      : head;
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const n = parseInt(g || '0', 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

/** Verdadeiro para IPv4 (string decimal pontuada) não-público. */
function isPrivateIpv4(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((n) => Number.isNaN(n) || n > 255)) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF)
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18/15
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64/10)
  if (a >= 224) return true; // multicast/reservado
  return false;
}

/**
 * Faixas de IP que NUNCA podem ser alvo (anti-SSRF): loopback, privados (RFC1918),
 * link-local/metadata cloud (169.254/16 — inclui 169.254.169.254), CGNAT, ULA IPv6,
 * multicast/reservado. IPv6 é EXPANDIDO e o IPv4 embutido (mapeado `::ffff:` em forma
 * decimal OU hex, compatível, e NAT64 `64:ff9b::/96`) é revalidado como IPv4. Qualquer
 * coisa não-pública (ou não-parseável) é rejeitada.
 */
function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const [a, b, c, d] = ip.split('.').map(Number);
    return isPrivateIpv4(a, b, c, d);
  }
  if (version === 6) {
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return true; // não-parseável → rejeita
    const zero = (from: number, to: number) => bytes.slice(from, to).every((x) => x === 0);
    // ::  e ::1 (unspecified/loopback)
    if (zero(0, 15) && (bytes[15] === 0 || bytes[15] === 1)) return true;
    // IPv4-mapeado ::ffff:a.b.c.d  e IPv4-compatível ::a.b.c.d
    if (zero(0, 10) && ((bytes[10] === 0xff && bytes[11] === 0xff) || zero(10, 12))) {
      return isPrivateIpv4(bytes[12], bytes[13], bytes[14], bytes[15]);
    }
    // NAT64 64:ff9b::/96 → IPv4 embutido nos últimos 32 bits
    if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12)) {
      return isPrivateIpv4(bytes[12], bytes[13], bytes[14], bytes[15]);
    }
    if ((bytes[0] & 0xff) === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // link-local fe80::/10
    if ((bytes[0] & 0xfe) === 0xfc) return true; // ULA fc00::/7
    return false;
  }
  return true; // não é IP válido → rejeita por segurança
}

/**
 * Valida que a URL é `https://` e que TODOS os endereços resolvidos do host são
 * públicos. Lança em qualquer violação (host interno, DNS que resolve p/ IP privado,
 * protocolo != https). Resolve `all: true` porque o DNS pode devolver múltiplos IPs
 * (basta um privado para abortar).
 */
async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  const u = new URL(raw); // lança em URL inválida
  if (u.protocol !== 'https:') throw new Error('non-https url blocked');

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('private ip blocked');
    return u;
  }
  const addrs = await lookup(host, { all: true });
  if (!addrs.length) throw new Error('dns resolution failed');
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('private ip blocked');
  }
  return u;
}

/**
 * Busca uma imagem remota e a re-encoda como data-URI PNG para templates de PDF.
 *
 * Por quê: o `@react-pdf/renderer` só decodifica PNG/JPEG — NÃO suporta WebP, e o
 * upload do projeto converte TODA imagem enviada para WebP (avatar do usuário, logo
 * da organização, imagem de produto). Passar a URL crua ao `<Image>` faz a imagem
 * simplesmente não renderizar. Re-encodando via `sharp` para PNG, o renderer exibe.
 * Como o `sharp` decodifica WebP/JPEG/PNG, normaliza qualquer origem (inclusive
 * avatares do Google em JPEG) para PNG.
 *
 * Segurança (anti-SSRF): as URLs de imagem vêm de campos que o usuário controla
 * (`avatarUrl`/`logoUrl`/`image` de produto), então:
 *  - aceita SOMENTE `https://`;
 *  - resolve o host e REJEITA qualquer IP não-público (loopback/privado/metadata);
 *  - segue redirects MANUALMENTE (`redirect: 'manual'`), revalidando CADA salto —
 *    fecha o bypass clássico "https externo → 302 → http://169.254.169.254/…".
 * (Residual conhecido, baixo: DNS rebinding entre a resolução e o fetch — mitigável
 * só com pin de IP + validação de cert, fora do escopo aqui.)
 * Fail-open: qualquer erro/bloqueio → `undefined` (o template usa fallback/omite a
 * imagem), nunca quebra o documento.
 *
 * @param url   URL https da imagem (ou null/undefined → retorna undefined).
 * @param size  lado do quadrado de saída em px (cover-crop). Default 144.
 */
export async function buildPdfImageDataUri(
  url?: string | null,
  size = 144,
): Promise<string | undefined> {
  if (!url) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    let current = url.trim();
    let res: Response | undefined;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let target: URL;
      try {
        target = await assertPublicHttpsUrl(current);
      } catch {
        return undefined; // host/protocolo/IP não permitido
      }

      const r = await fetch(target, {
        signal: controller.signal,
        redirect: 'manual',
      });

      // Redirect: revalida o próximo salto em vez de deixar o fetch seguir sozinho.
      if (r.status >= 300 && r.status < 400) {
        const location = r.headers.get('location');
        if (!location) return undefined;
        current = new URL(location, target).toString(); // resolve relativo
        continue;
      }

      res = r;
      break;
    }

    if (!res || !res.ok) return undefined;

    // Rejeita cedo pelo Content-Length; e faz leitura em STREAM com teto de bytes
    // (o header pode mentir/faltar) — evita bufferizar um corpo de vários GB.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return undefined;

    const reader = res.body?.getReader();
    if (!reader) return undefined;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(Buffer.from(value));
    }
    const buf = Buffer.concat(chunks);

    const png = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize(size, size, { fit: 'cover' })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return undefined; // fail-open: nunca quebra a geração do PDF
  } finally {
    clearTimeout(timeout);
  }
}
