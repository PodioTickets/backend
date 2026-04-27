import { Injectable } from '@nestjs/common';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Storage, Bucket } from '@google-cloud/storage';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ClamScan = require('clamscan');

@Injectable()
export class UploadService {
  private readonly bucket: Bucket;
  private readonly cdnUrl: string;
  private readonly cdnEnabled: boolean;

  /** Scanner ClamAV reutilizado entre uploads (evita custo de createScanner a cada arquivo). */
  private clamScannerPromise: Promise<{ scanFile: (p: string) => Promise<{ isInfected: boolean; viruses?: string[] }> }> | null =
    null;

  constructor() {
    this.cdnEnabled = process.env.CDN_ENABLED === 'true';
    this.cdnUrl = (process.env.CDN_URL ?? '').replace(/\/$/, '');

    const storageOptions: ConstructorParameters<typeof Storage>[0] = {};
    if (process.env.GCP_PROJECT_ID) storageOptions.projectId = process.env.GCP_PROJECT_ID;
    if (process.env.GCS_KEY_FILE) storageOptions.keyFilename = process.env.GCS_KEY_FILE;

    const storage = new Storage(storageOptions);
    const bucketName = process.env.GCS_BUCKET ?? process.env.BUCKET_NAME ?? '';
    this.bucket = storage.bucket(bucketName);
  }

  async compressImage(file: any): Promise<string> {
    try {
      if (!file || !file.buffer) throw new Error('No file uploaded or file buffer missing');

      await this.scanForMalware(file.buffer, file.originalname || 'uploaded-file');

      const originalExt = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      const objectName = `images/${Date.now()}-${Math.round(Math.random() * 1e9)}${originalExt}`;

      await this.uploadToGcs(objectName, file.buffer, file.mimetype || 'image/jpeg');

      console.log(`✅ Image uploaded to GCS: ${objectName} (${this.formatFileSize(file.buffer.length)})`);
      return this.buildUrl(objectName);
    } catch (error) {
      console.error('❌ Failed to upload image:', error);
      throw new Error(`Failed to process image: ${error.message}`);
    }
  }

  async uploadPdf(file: any): Promise<string> {
    try {
      if (!file || !file.buffer) throw new Error('No file uploaded or file buffer missing');

      const fileExtension = path.extname(file.originalname || '').toLowerCase();
      if (fileExtension !== '.pdf') throw new Error('File must be a PDF');

      await this.scanForMalware(file.buffer, file.originalname || 'uploaded-file');

      const maxSize = 10 * 1024 * 1024;
      if (file.buffer.length > maxSize) {
        throw new Error(`PDF file size exceeds maximum allowed size of ${this.formatFileSize(maxSize)}`);
      }

      const objectName = `pdfs/${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`;
      await this.uploadToGcs(objectName, file.buffer, 'application/pdf');

      console.log(`✅ PDF uploaded to GCS: ${objectName} (${this.formatFileSize(file.buffer.length)})`);
      return this.buildUrl(objectName);
    } catch (error) {
      console.error('❌ Failed to upload PDF:', error);
      throw new Error(`Failed to upload PDF: ${error.message}`);
    }
  }

  async getAllUploads(params?: {
    page?: number;
    limit?: number;
    sortBy?: 'name' | 'date';
    sortOrder?: 'asc' | 'desc';
  }) {
    try {
      const { page = 1, limit = 50, sortBy = 'date', sortOrder = 'desc' } = params || {};

      const [gcsFiles] = await this.bucket.getFiles({ prefix: 'images/' });

      const imageExtensions = ['.webp', '.jpg', '.jpeg', '.png'];
      const filesWithInfo = gcsFiles
        .filter((f) => imageExtensions.includes(path.extname(f.name).toLowerCase()))
        .map((f) => {
          const meta = f.metadata;
          const size = Number(meta.size ?? 0);
          const createdAt = meta.timeCreated ? new Date(meta.timeCreated) : new Date(0);
          const modifiedAt = meta.updated ? new Date(meta.updated) : createdAt;
          const filename = path.basename(f.name);
          return {
            filename,
            url: this.buildUrl(f.name),
            size,
            sizeFormatted: this.formatFileSize(size),
            createdAt,
            modifiedAt,
            extension: path.extname(filename).toLowerCase(),
          };
        });

      filesWithInfo.sort((a, b) => {
        let cmp = 0;
        if (sortBy === 'name') cmp = a.filename.localeCompare(b.filename);
        else cmp = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        return sortOrder === 'desc' ? -cmp : cmp;
      });

      const totalFiles = filesWithInfo.length;
      const totalPages = Math.ceil(totalFiles / limit);
      const paginatedFiles = filesWithInfo.slice((page - 1) * limit, page * limit);

      return {
        success: true,
        data: {
          files: paginatedFiles,
          pagination: {
            currentPage: page,
            totalPages,
            totalFiles,
            filesPerPage: limit,
            hasNextPage: page < totalPages,
            hasPreviousPage: page > 1,
          },
        },
        message: `Found ${totalFiles} uploaded files`,
      };
    } catch (error) {
      console.error('❌ Failed to get uploads:', error);
      throw new Error(`Failed to get uploads: ${error.message}`);
    }
  }

  async getUploadStats() {
    try {
      const [gcsFiles] = await this.bucket.getFiles({ prefix: 'images/' });

      const imageExtensions = ['.webp', '.jpg', '.jpeg', '.png'];
      const filesWithInfo = gcsFiles
        .filter((f) => imageExtensions.includes(path.extname(f.name).toLowerCase()))
        .map((f) => {
          const meta = f.metadata;
          return {
            filename: path.basename(f.name),
            size: Number(meta.size ?? 0),
            createdAt: meta.timeCreated ? new Date(meta.timeCreated) : new Date(0),
            extension: path.extname(f.name).toLowerCase(),
          };
        });

      if (filesWithInfo.length === 0) {
        return {
          success: true,
          data: {
            totalFiles: 0,
            totalSize: 0,
            totalSizeFormatted: '0 Bytes',
            averageFileSize: 0,
            averageFileSizeFormatted: '0 Bytes',
            extensions: {},
            dateRange: null,
          },
          message: 'No uploaded files found',
        };
      }

      const totalFiles = filesWithInfo.length;
      const totalSize = filesWithInfo.reduce((sum, f) => sum + f.size, 0);
      const averageFileSize = totalSize / totalFiles;

      const extensions: Record<string, { count: number; totalSize: number; totalSizeFormatted?: string; percentage?: string }> = {};
      filesWithInfo.forEach((f) => {
        if (!extensions[f.extension]) extensions[f.extension] = { count: 0, totalSize: 0 };
        extensions[f.extension].count++;
        extensions[f.extension].totalSize += f.size;
      });
      Object.keys(extensions).forEach((ext) => {
        extensions[ext].totalSizeFormatted = this.formatFileSize(extensions[ext].totalSize);
        extensions[ext].percentage = ((extensions[ext].count / totalFiles) * 100).toFixed(1) + '%';
      });

      const dates = filesWithInfo.map((f) => f.createdAt.getTime());
      return {
        success: true,
        data: {
          totalFiles,
          totalSize,
          totalSizeFormatted: this.formatFileSize(totalSize),
          averageFileSize,
          averageFileSizeFormatted: this.formatFileSize(averageFileSize),
          extensions,
          dateRange: {
            earliest: new Date(Math.min(...dates)),
            latest: new Date(Math.max(...dates)),
          },
        },
        message: `Statistics calculated for ${totalFiles} uploaded files`,
      };
    } catch (error) {
      console.error('❌ Failed to get upload stats:', error);
      throw new Error(`Failed to get upload stats: ${error.message}`);
    }
  }

  async deleteUpload(filename: string) {
    try {
      if (!filename || typeof filename !== 'string') throw new Error('Nome do arquivo inválido');

      const sanitizedFilename = filename.replace(/[^a-zA-Z0-9\-_.]/g, '');
      const allowedExtensions = ['.webp', '.jpg', '.jpeg', '.png'];
      const extension = path.extname(sanitizedFilename).toLowerCase();
      if (!allowedExtensions.includes(extension)) throw new Error('Tipo de arquivo não permitido para exclusão');

      const objectName = `images/${sanitizedFilename}`;
      const gcsFile = this.bucket.file(objectName);

      const [exists] = await gcsFile.exists();
      if (!exists) throw new Error('Arquivo não encontrado');

      const [meta] = await gcsFile.getMetadata();
      const size = Number(meta.size ?? 0);

      await gcsFile.delete();

      console.log(`🗑️ File deleted from GCS: ${objectName} (${this.formatFileSize(size)})`);
      return {
        success: true,
        data: {
          deletedFile: {
            filename: sanitizedFilename,
            size,
            sizeFormatted: this.formatFileSize(size),
            extension,
          },
        },
        message: `Arquivo ${sanitizedFilename} removido com sucesso`,
      };
    } catch (error) {
      console.error('❌ Failed to delete upload:', error);
      throw new Error(`Falha ao deletar arquivo: ${error.message}`);
    }
  }

  async deleteMultipleUploads(filenames: string[]) {
    try {
      if (!Array.isArray(filenames) || filenames.length === 0) throw new Error('Lista de arquivos inválida');
      if (filenames.length > 50) throw new Error('Não é possível deletar mais de 50 arquivos por vez');

      const results: any[] = [];
      const errors: Array<{ filename: string; error: string }> = [];

      for (const filename of filenames) {
        try {
          const result = await this.deleteUpload(filename);
          results.push(result.data.deletedFile);
        } catch (error) {
          errors.push({ filename, error: error.message });
        }
      }

      return {
        success: true,
        data: {
          deletedFiles: results,
          errors,
          totalRequested: filenames.length,
          totalDeleted: results.length,
          totalErrors: errors.length,
        },
        message: `Processamento concluído: ${results.length} deletados, ${errors.length} erros`,
      };
    } catch (error) {
      console.error('❌ Failed to delete multiple uploads:', error);
      throw new Error(`Falha ao deletar múltiplos arquivos: ${error.message}`);
    }
  }

  async batchUploadImages(files: any[]): Promise<{
    total: number;
    success: number;
    failed: number;
    urls: string[];
    errors: Array<{ index: number; filename: string; error: string }>;
  }> {
    try {
      if (!Array.isArray(files) || files.length === 0) throw new Error('Nenhum arquivo enviado');
      if (files.length > 20) throw new Error('Não é possível fazer upload de mais de 20 arquivos por vez');

      console.log(`📦 Iniciando upload em batch de ${files.length} arquivos...`);

      const urls: string[] = [];
      const errors: Array<{ index: number; filename: string; error: string }> = [];
      let successCount = 0;
      let failedCount = 0;

      const batchSize = 5;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (file, batchIndex) => {
            const globalIndex = i + batchIndex;
            try {
              const url = await this.compressImage(file);
              urls.push(url);
              successCount++;
            } catch (error) {
              failedCount++;
              errors.push({
                index: globalIndex,
                filename: file.originalname || `arquivo-${globalIndex + 1}`,
                error: error.message || 'Erro desconhecido',
              });
            }
          }),
        );
      }

      console.log(`🎉 Upload em batch concluído: ${successCount} sucesso, ${failedCount} falhas`);
      return { total: files.length, success: successCount, failed: failedCount, urls, errors };
    } catch (error) {
      console.error('❌ Erro no upload em batch:', error);
      throw new Error(`Falha no upload em batch: ${error.message}`);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async uploadToGcs(objectName: string, buffer: Buffer, contentType: string): Promise<void> {
    const gcsFile = this.bucket.file(objectName);
    await gcsFile.save(buffer, {
      metadata: { contentType },
      resumable: false,
    });
  }

  private buildUrl(objectName: string): string {
    if (this.cdnEnabled && this.cdnUrl) {
      return `${this.cdnUrl}/${objectName}`;
    }
    const bucketName = this.bucket.name;
    return `https://storage.googleapis.com/${bucketName}/${objectName}`;
  }

  private getOrCreateClamScanner(): Promise<{
    scanFile: (p: string) => Promise<{ isInfected: boolean; viruses?: string[] }>;
  }> {
    if (!this.clamScannerPromise) {
      this.clamScannerPromise = ClamScan.createScanner({
        removeInfected: false,
        quarantineInfected: false,
        scanLog: null,
        debugMode: false,
        fileList: null,
        scanArchives: false,
        scanRecursively: false,
      }).catch((err) => {
        this.clamScannerPromise = null;
        throw err;
      });
    }
    return this.clamScannerPromise;
  }

  private async scanForMalware(buffer: Buffer, filename: string): Promise<void> {
    if (process.env.UPLOAD_SKIP_CLAMAV === 'true') return;
    try {
      const clamscan = await this.getOrCreateClamScanner();
      const tempFilePath = path.join(os.tmpdir(), `scan-${Date.now()}-${Math.round(Math.random() * 1e9)}`);
      try {
        await fs.writeFile(tempFilePath, buffer);
        const scanResult = await clamscan.scanFile(tempFilePath);
        if (scanResult.isInfected) {
          console.error(`🚨 Malware detected in file: ${filename}`, { viruses: scanResult.viruses });
          throw new Error('Malware detected in uploaded file. File rejected for security reasons.');
        }
        console.log(`✅ Malware scan passed for: ${filename}`);
      } finally {
        try { await fs.unlink(tempFilePath); } catch { /* ignore */ }
      }
    } catch (error) {
      if (error.message.includes('Malware detected')) throw error;
      console.warn(`⚠️ Malware scan unavailable: ${error.message}. Upload allowed but logged.`);
    }
  }

  private formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}
