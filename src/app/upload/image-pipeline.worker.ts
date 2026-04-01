/**
 * Worker thread: ClamAV + Sharp (WebP lossless). Mesma lógica de segurança do UploadService.
 * Compilado para dist/.../image-pipeline.worker.js pelo Nest.
 */
import { parentPort, workerData } from 'worker_threads';
import sharp from 'sharp';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as ClamScan from 'clamscan';

type WorkerIn = {
  buffer: ArrayBuffer;
  uploadDir: string;
  originalname: string;
};

async function scanForMalware(
  buffer: Buffer,
  filename: string,
  uploadDir: string,
): Promise<void> {
  try {
    const clamscan = await ClamScan.createScanner({
      removeInfected: false,
      quarantineInfected: false,
      scanLog: null,
      debugMode: false,
      fileList: null,
      scanArchives: true,
      scanRecursively: true,
    });

    const tempFilename = `temp-scan-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const tempFilePath = path.join(uploadDir, tempFilename);

    try {
      await fs.writeFile(tempFilePath, buffer);
      const scanResult = await clamscan.scanFile(tempFilePath);
      if (scanResult.isInfected) {
        throw new Error(
          `Malware detected in uploaded file. File rejected for security reasons.`,
        );
      }
    } finally {
      try {
        await fs.unlink(tempFilePath);
      } catch {
        /* ignore */
      }
    }
  } catch (error: any) {
    if (error?.message?.includes('Malware detected')) {
      throw error;
    }
    console.warn(
      `⚠️ Malware scan unavailable (worker): ${error?.message}. Upload allowed but logged.`,
    );
  }
}

async function main() {
  const { buffer: ab, uploadDir, originalname } = workerData as WorkerIn;
  const buf = Buffer.from(ab);
  await scanForMalware(buf, originalname || 'uploaded-file', uploadDir);

  const webp = await sharp(buf)
    .webp({ quality: 100, effort: 6, lossless: true })
    .toBuffer();

  const copy = new ArrayBuffer(webp.length);
  new Uint8Array(copy).set(webp);
  parentPort!.postMessage({ ok: true, ab: copy }, [copy]);
}

main().catch((err: Error) => {
  parentPort!.postMessage({
    ok: false,
    error: err?.message || String(err),
  });
});
