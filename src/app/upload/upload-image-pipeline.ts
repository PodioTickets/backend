import sharp from 'sharp';

function parsePositiveInt(env: string | undefined, fallback: number): number {
  if (env === undefined || env === '') return fallback;
  const n = parseInt(env, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Máximo da aresta em px; `0` desliga redimensionamento. Default 2048. */
export function getUploadMaxImageEdge(): number {
  const n = parsePositiveInt(process.env.UPLOAD_MAX_IMAGE_EDGE, 2048);
  return Math.max(0, n);
}

export function getWebpEncodeOptions(): { quality: number; effort: number } {
  const quality = Math.min(
    100,
    Math.max(1, parsePositiveInt('90', 85)),
  );
  const effort = Math.min(
    6,
    Math.max(0, parsePositiveInt(process.env.UPLOAD_WEBP_EFFORT, 4)),
  );
  return { quality, effort };
}

/**
 * Rotação EXIF + limite de tamanho + WebP com perda (rápido vs lossless effort 6).
 */
export async function encodeImageBufferToWebp(buf: Buffer): Promise<Buffer> {
  const maxEdge = getUploadMaxImageEdge();
  const { quality, effort } = getWebpEncodeOptions();
  let pipeline = sharp(buf).rotate();
  if (maxEdge > 0) {
    pipeline = pipeline.resize(maxEdge, maxEdge, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  return pipeline.webp({ quality, effort }).toBuffer();
}
