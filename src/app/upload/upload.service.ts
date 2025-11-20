import { Injectable } from '@nestjs/common';
import * as sharp from 'sharp';
import * as fs from 'fs/promises';
import * as path from 'path';
import { stat } from 'fs/promises';
import * as ClamScan from 'clamscan';

@Injectable()
export class UploadService {
  private readonly uploadDir = path.join(process.cwd(), 'uploads', 'images');

  constructor() {
    this.ensureUploadDirectory();
  }

  private async ensureUploadDirectory() {
    try {
      await fs.access(this.uploadDir);
    } catch {
      await fs.mkdir(this.uploadDir, { recursive: true });
      console.log('📁 Upload directory created:', this.uploadDir);
    }
  }

  async compressImage(file: any) {
    try {
      if (!file || !file.buffer) {
        throw new Error('No file uploaded or file buffer missing');
      }

      // Verificar malware antes do processamento
      await this.scanForMalware(
        file.buffer,
        file.originalname || 'uploaded-file',
      );

      const compressedBuffer = await sharp(file.buffer)
        .webp({ quality: 80, effort: 6, lossless: false })
        .resize({
          width: 500,
          height: 500,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toBuffer();

      const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.webp`;
      const filePath = path.join(this.uploadDir, filename);
      await fs.writeFile(filePath, compressedBuffer);

      console.log(
        `✅ File processed and saved: ${filename} (${this.formatFileSize(compressedBuffer.length)})`,
      );
      return `/uploads/images/${filename}`;
    } catch (error) {
      console.error('❌ Failed to compress and save image:', error);
      throw new Error(`Failed to process image: ${error.message}`);
    }
  }

  private async scanForMalware(
    buffer: Buffer,
    filename: string,
  ): Promise<void> {
    try {
      // Configuração do ClamAV
      const clamscan = await ClamScan.createScanner({
        removeInfected: false, // Não remover automaticamente, apenas reportar
        quarantineInfected: false, // Não quarentena, apenas reportar
        scanLog: null, // Desabilitar log do scanner
        debugMode: false,
        fileList: null,
        scanArchives: true, // Verificar arquivos dentro de archives
        scanRecursively: true, // Verificar recursivamente
      });

      // Criar arquivo temporário para scan
      const tempFilename = `temp-scan-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const tempFilePath = path.join(this.uploadDir, tempFilename);

      try {
        // Escrever buffer no arquivo temporário
        await fs.writeFile(tempFilePath, buffer);

        // Executar scan
        const scanResult = await clamscan.scanFile(tempFilePath);

        if (scanResult.isInfected) {
          console.error(`🚨 Malware detected in file: ${filename}`, {
            viruses: scanResult.viruses,
            file: tempFilePath,
          });

          throw new Error(
            `Malware detected in uploaded file. File rejected for security reasons.`,
          );
        }

        console.log(`✅ Malware scan passed for: ${filename}`);
      } finally {
        // Sempre remover arquivo temporário
        try {
          await fs.unlink(tempFilePath);
        } catch (cleanupError) {
          console.warn(
            `⚠️ Failed to cleanup temp file: ${tempFilePath}`,
            cleanupError,
          );
        }
      }
    } catch (error) {
      if (error.message.includes('Malware detected')) {
        throw error; // Re-throw malware error
      }

      // Se ClamAV não estiver disponível, logar warning mas permitir upload
      console.warn(
        `⚠️ Malware scan unavailable: ${error.message}. Upload allowed but logged.`,
      );
      console.warn(
        `📝 Consider installing ClamAV for enhanced security: https://www.clamav.net/`,
      );
    }
  }

  async getAllUploads(params?: {
    page?: number;
    limit?: number;
    sortBy?: 'name' | 'date';
    sortOrder?: 'asc' | 'desc';
  }) {
    try {
      const {
        page = 1,
        limit = 50,
        sortBy = 'date',
        sortOrder = 'desc',
      } = params || {};

      // Garante que o diretório existe
      await this.ensureUploadDirectory();

      // Lê todos os arquivos do diretório
      const files = await fs.readdir(this.uploadDir);

      // Filtra apenas arquivos de imagem
      const imageFiles = files.filter(
        (file) =>
          file.endsWith('.webp') ||
          file.endsWith('.jpg') ||
          file.endsWith('.jpeg') ||
          file.endsWith('.png'),
      );

      // Obtém informações detalhadas de cada arquivo
      const filesWithInfo = await Promise.all(
        imageFiles.map(async (filename) => {
          const filePath = path.join(this.uploadDir, filename);
          const stats = await stat(filePath);
          const fileSize = stats.size;
          const createdAt = stats.birthtime;
          const modifiedAt = stats.mtime;

          return {
            filename,
            url: `/uploads/images/${filename}`,
            size: fileSize,
            sizeFormatted: this.formatFileSize(fileSize),
            createdAt,
            modifiedAt,
            extension: path.extname(filename).toLowerCase(),
          };
        }),
      );

      // Ordena os arquivos
      filesWithInfo.sort((a, b) => {
        let comparison = 0;

        if (sortBy === 'name') {
          comparison = a.filename.localeCompare(b.filename);
        } else if (sortBy === 'date') {
          comparison =
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }

        return sortOrder === 'desc' ? -comparison : comparison;
      });

      // Implementa paginação
      const totalFiles = filesWithInfo.length;
      const totalPages = Math.ceil(totalFiles / limit);
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;
      const paginatedFiles = filesWithInfo.slice(startIndex, endIndex);

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
      // Garante que o diretório existe
      await this.ensureUploadDirectory();

      // Lê todos os arquivos do diretório
      const files = await fs.readdir(this.uploadDir);

      // Filtra apenas arquivos de imagem
      const imageFiles = files.filter(
        (file) =>
          file.endsWith('.webp') ||
          file.endsWith('.jpg') ||
          file.endsWith('.jpeg') ||
          file.endsWith('.png'),
      );

      if (imageFiles.length === 0) {
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

      // Obtém informações detalhadas de cada arquivo
      const filesWithInfo = await Promise.all(
        imageFiles.map(async (filename) => {
          const filePath = path.join(this.uploadDir, filename);
          const stats = await stat(filePath);

          return {
            filename,
            size: stats.size,
            createdAt: stats.birthtime,
            extension: path.extname(filename).toLowerCase(),
          };
        }),
      );

      // Calcula estatísticas
      const totalFiles = filesWithInfo.length;
      const totalSize = filesWithInfo.reduce((sum, file) => sum + file.size, 0);
      const averageFileSize = totalSize / totalFiles;

      // Estatísticas por extensão
      const extensions = {};
      filesWithInfo.forEach((file) => {
        const ext = file.extension;
        if (!extensions[ext]) {
          extensions[ext] = { count: 0, totalSize: 0 };
        }
        extensions[ext].count++;
        extensions[ext].totalSize += file.size;
      });

      // Formata estatísticas de extensão
      Object.keys(extensions).forEach((ext) => {
        extensions[ext].totalSizeFormatted = this.formatFileSize(
          extensions[ext].totalSize,
        );
        extensions[ext].percentage =
          ((extensions[ext].count / totalFiles) * 100).toFixed(1) + '%';
      });

      // Encontra intervalo de datas
      const dates = filesWithInfo.map((file) => new Date(file.createdAt));
      const earliestDate = new Date(Math.min(...dates.map((d) => d.getTime())));
      const latestDate = new Date(Math.max(...dates.map((d) => d.getTime())));

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
            earliest: earliestDate,
            latest: latestDate,
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
      // Valida o nome do arquivo para prevenir ataques de path traversal
      if (!filename || typeof filename !== 'string') {
        throw new Error('Nome do arquivo inválido');
      }

      // Remove caracteres perigosos do nome do arquivo
      const sanitizedFilename = filename.replace(/[^a-zA-Z0-9\-_\.]/g, '');

      // Verifica se é uma extensão permitida
      const allowedExtensions = ['.webp', '.jpg', '.jpeg', '.png'];
      const extension = path.extname(sanitizedFilename).toLowerCase();

      if (!allowedExtensions.includes(extension)) {
        throw new Error('Tipo de arquivo não permitido para exclusão');
      }

      const filePath = path.join(this.uploadDir, sanitizedFilename);

      // Verifica se o arquivo existe
      try {
        await fs.access(filePath);
      } catch {
        throw new Error('Arquivo não encontrado');
      }

      // Obtém informações do arquivo antes de deletar (para logging)
      const stats = await stat(filePath);
      const fileInfo = {
        filename: sanitizedFilename,
        size: stats.size,
        sizeFormatted: this.formatFileSize(stats.size),
        createdAt: stats.birthtime,
        extension,
      };

      // Remove o arquivo
      await fs.unlink(filePath);

      console.log(
        `🗑️ File deleted: ${sanitizedFilename} (${fileInfo.sizeFormatted})`,
      );

      return {
        success: true,
        data: {
          deletedFile: fileInfo,
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
      if (!Array.isArray(filenames) || filenames.length === 0) {
        throw new Error('Lista de arquivos inválida');
      }

      if (filenames.length > 50) {
        throw new Error('Não é possível deletar mais de 50 arquivos por vez');
      }

      const results = [];
      const errors = [];

      for (const filename of filenames) {
        try {
          const result = await this.deleteUpload(filename);
          results.push(result.data.deletedFile);
        } catch (error) {
          errors.push({
            filename,
            error: error.message,
          });
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
      if (!Array.isArray(files) || files.length === 0) {
        throw new Error('Nenhum arquivo enviado');
      }

      if (files.length > 20) {
        throw new Error('Não é possível fazer upload de mais de 20 arquivos por vez');
      }

      console.log(`📦 Iniciando upload em batch de ${files.length} arquivos...`);

      const results: string[] = [];
      const errors: Array<{ index: number; filename: string; error: string }> = [];
      let successCount = 0;
      let failedCount = 0;

      // Processar arquivos em paralelo, mas com limite de concorrência
      const batchSize = 5; // Processar no máximo 5 arquivos simultaneamente
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        const batchPromises = batch.map(async (file, batchIndex) => {
          const globalIndex = i + batchIndex;
          try {
            console.log(`📤 Processando arquivo ${globalIndex + 1}/${files.length}: ${file.originalname || 'arquivo-sem-nome'}`);

            const imageUrl = await this.compressImage(file);
            results.push(imageUrl);
            successCount++;

            console.log(`✅ Arquivo ${globalIndex + 1}/${files.length} processado com sucesso`);
            return { success: true, index: globalIndex };
          } catch (error) {
            failedCount++;
            const filename = file.originalname || `arquivo-${globalIndex + 1}`;
            const errorMessage = error.message || 'Erro desconhecido';

            errors.push({
              index: globalIndex,
              filename,
              error: errorMessage,
            });

            console.error(`❌ Falha no arquivo ${globalIndex + 1}/${files.length} (${filename}): ${errorMessage}`);
            return { success: false, index: globalIndex, error: errorMessage };
          }
        });

        // Aguardar conclusão do lote atual antes de processar o próximo
        await Promise.all(batchPromises);

        console.log(`📊 Lote ${Math.floor(i / batchSize) + 1}/${Math.ceil(files.length / batchSize)} concluído: ${successCount} sucesso, ${failedCount} falhas`);
      }

      console.log(`🎉 Upload em batch concluído: ${successCount} sucesso, ${failedCount} falhas`);

      return {
        total: files.length,
        success: successCount,
        failed: failedCount,
        urls: results,
        errors,
      };
    } catch (error) {
      console.error('❌ Erro no upload em batch:', error);
      throw new Error(`Falha no upload em batch: ${error.message}`);
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
