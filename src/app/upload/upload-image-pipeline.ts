import sharp from 'sharp';

function parsePositiveInt(env: string | undefined, fallback: number): number {
  if (env === undefined || env === '') return fallback;
  const n = parseInt(env, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function getWebpEffort(): number {
  return Math.min(6, Math.max(0, parsePositiveInt(process.env.UPLOAD_WEBP_EFFORT, 4)));
}

/**
 * Rotação EXIF + WebP lossless — zero perda de qualidade.
 * O effort (0-6) controla velocidade vs tamanho do arquivo, não qualidade.
 */
export async function encodeImageBufferToWebp(buf: Buffer): Promise<Buffer> {
  const effort = getWebpEffort();
  return sharp(buf)
    .rotate()
    .webp({ lossless: true, effort })
    .toBuffer();
}
