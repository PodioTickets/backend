import * as sharpLib from 'sharp';

const sharp = (sharpLib as any).default ?? sharpLib;

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
 * Segurança: aceita SOMENTE `https://` (o fetch nativo acessaria `file:///`,
 * `http://localhost`, etc. — vetor de SSRF). Performance: timeout curto para não
 * travar a geração do PDF. Fail-open: qualquer erro → `undefined` (o template usa
 * o fallback/omite a imagem), nunca quebra o documento.
 *
 * @param url   URL https da imagem (ou null/undefined → retorna undefined).
 * @param size  lado do quadrado de saída em px (cover-crop). Default 144.
 */
export async function buildPdfImageDataUri(
  url?: string | null,
  size = 144,
): Promise<string | undefined> {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!/^https:\/\//i.test(trimmed)) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(trimmed, { signal: controller.signal });
    if (!res.ok) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    const png = await sharp(buf).resize(size, size, { fit: 'cover' }).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } finally {
    clearTimeout(timeout);
  }
}
