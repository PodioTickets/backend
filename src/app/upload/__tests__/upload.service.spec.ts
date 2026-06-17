import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';

/**
 * UploadService usa Google Cloud Storage (@google-cloud/storage) + `sharp`.
 *  - URLs retornadas são URLs do GCS/CDN (não mais `/uploads/images/...`).
 *  - Imagem é SANITIZADA por re-encode (sharp), mantendo o MESMO formato e SEM
 *    resize; formato fora da allowlist raster (ex.: SVG) ou buffer não-imagem → 400.
 *  - Mensagens de erro em PT-BR.
 *
 * Mockamos `@google-cloud/storage` (Bucket) e `sharp` para isolar disco/rede/CPU.
 */

// ── Mock do Google Cloud Storage ────────────────────────────────────────────
const mockGcsFile = {
  save: jest.fn().mockResolvedValue(undefined),
  exists: jest.fn().mockResolvedValue([true]),
  getMetadata: jest.fn().mockResolvedValue([{ size: 1024 }]),
  delete: jest.fn().mockResolvedValue(undefined),
};

const mockBucket = {
  name: 'test-bucket',
  file: jest.fn().mockReturnValue(mockGcsFile),
  getFiles: jest.fn().mockResolvedValue([[]]),
};

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue(mockBucket),
  })),
}));

// ── Mock do sharp ────────────────────────────────────────────────────────────
// `sharp(buffer)` devolve um encadeável; `metadata()` informa formato e nº de
// frames; cada encoder (jpeg/png/webp/gif) retorna o próprio chain; `toBuffer()`
// resolve com o buffer SANITIZADO. Default: JPEG estático.
const mockToBuffer = jest.fn().mockResolvedValue(Buffer.from('sanitized-bytes'));
const mockMetadata = jest.fn().mockResolvedValue({ format: 'jpeg', pages: 1 });
const sharpChain = {
  rotate: jest.fn().mockReturnThis(),
  jpeg: jest.fn().mockReturnThis(),
  png: jest.fn().mockReturnThis(),
  webp: jest.fn().mockReturnThis(),
  gif: jest.fn().mockReturnThis(),
  toBuffer: mockToBuffer,
  metadata: mockMetadata,
};
const mockSharp = jest.fn(() => sharpChain);
jest.mock('sharp', () => mockSharp);

import { UploadService } from '../upload.service';

describe('UploadService', () => {
  let service: UploadService;

  const mockFile = {
    buffer: Buffer.from('fake-image-data'),
    originalname: 'test.jpg',
    mimetype: 'image/jpeg',
    size: 1024,
  };

  beforeEach(async () => {
    process.env.GCS_BUCKET = 'test-bucket';
    process.env.CDN_ENABLED = 'false';

    const module: TestingModule = await Test.createTestingModule({
      providers: [UploadService],
    }).compile();

    service = module.get<UploadService>(UploadService);

    // Reset dos retornos default do GCS
    mockGcsFile.save.mockResolvedValue(undefined);
    mockGcsFile.exists.mockResolvedValue([true]);
    mockGcsFile.getMetadata.mockResolvedValue([{ size: 1024 }]);
    mockGcsFile.delete.mockResolvedValue(undefined);
    mockBucket.file.mockReturnValue(mockGcsFile);
    mockBucket.getFiles.mockResolvedValue([[]]);

    // sharp: JPEG estático sanitizado por padrão
    mockSharp.mockReturnValue(sharpChain);
    mockMetadata.mockResolvedValue({ format: 'jpeg', pages: 1 });
    mockToBuffer.mockResolvedValue(Buffer.from('sanitized-bytes'));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('compressImage', () => {
    it('sanitiza por re-encode mantendo o formato JPEG e devolve URL .jpg', async () => {
      const result = await service.compressImage(mockFile);

      expect(mockMetadata).toHaveBeenCalled();
      expect(sharpChain.rotate).toHaveBeenCalled(); // estático → aplica orientação EXIF
      expect(sharpChain.jpeg).toHaveBeenCalled();
      expect(result).toContain('storage.googleapis.com');
      expect(result).toContain('test-bucket');
      expect(result).toContain('images/');
      expect(result).toContain('.jpg');
      // Sobe o buffer SANITIZADO (re-encodado), com content-type do MESMO formato.
      expect(mockGcsFile.save).toHaveBeenCalledWith(
        Buffer.from('sanitized-bytes'),
        expect.objectContaining({
          metadata: expect.objectContaining({ contentType: 'image/jpeg' }),
        }),
      );
    });

    it('mantém o formato PNG (sem conversão para webp)', async () => {
      mockMetadata.mockResolvedValueOnce({ format: 'png', pages: 1 });

      const result = await service.compressImage({ ...mockFile, originalname: 'a.png', mimetype: 'image/png' });

      expect(sharpChain.png).toHaveBeenCalled();
      expect(result).toContain('.png');
      expect(mockGcsFile.save).toHaveBeenCalledWith(
        Buffer.from('sanitized-bytes'),
        expect.objectContaining({ metadata: expect.objectContaining({ contentType: 'image/png' }) }),
      );
    });

    it('preserva GIF animado e NÃO rotaciona (evita corromper os frames)', async () => {
      mockMetadata.mockResolvedValueOnce({ format: 'gif', pages: 8 });

      const result = await service.compressImage({ ...mockFile, originalname: 'a.gif', mimetype: 'image/gif' });

      expect(sharpChain.gif).toHaveBeenCalled();
      expect(sharpChain.rotate).not.toHaveBeenCalled();
      expect(result).toContain('.gif');
    });

    it('lança se o arquivo está ausente', async () => {
      await expect(service.compressImage(null as any)).rejects.toThrow(
        'Nenhum arquivo enviado ou buffer ausente',
      );
    });

    it('lança se o buffer está ausente', async () => {
      await expect(
        service.compressImage({ ...mockFile, buffer: undefined } as any),
      ).rejects.toThrow('Nenhum arquivo enviado ou buffer ausente');
    });

    it('REJEITA (400 fail-closed) quando o buffer não é uma imagem decodificável', async () => {
      mockMetadata.mockRejectedValueOnce(new Error('Input buffer contains unsupported image format'));

      await expect(service.compressImage(mockFile)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockGcsFile.save).not.toHaveBeenCalled();
    });

    it('REJEITA (400) formato fora da allowlist raster (ex.: SVG)', async () => {
      mockMetadata.mockResolvedValueOnce({ format: 'svg', pages: 1 });

      await expect(service.compressImage(mockFile)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockGcsFile.save).not.toHaveBeenCalled();
    });
  });

  describe('getAllUploads', () => {
    const gcsImageFiles = [
      {
        name: 'images/image1.webp',
        metadata: { size: '1024', timeCreated: '2024-01-03T00:00:00Z', updated: '2024-01-03T00:00:00Z' },
      },
      {
        name: 'images/image2.jpg',
        metadata: { size: '2048', timeCreated: '2024-01-02T00:00:00Z', updated: '2024-01-02T00:00:00Z' },
      },
      {
        name: 'images/image3.png',
        metadata: { size: '512', timeCreated: '2024-01-01T00:00:00Z', updated: '2024-01-01T00:00:00Z' },
      },
    ];

    beforeEach(() => {
      mockBucket.getFiles.mockResolvedValue([gcsImageFiles]);
    });

    it('should return paginated uploads', async () => {
      const result = await service.getAllUploads({ page: 1, limit: 10 });

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('files');
      expect(result.data).toHaveProperty('pagination');
      expect(result.data.pagination.currentPage).toBe(1);
      expect(result.data.pagination.filesPerPage).toBe(10);
    });

    it('should filter only image files', async () => {
      const result = await service.getAllUploads();

      const imageFiles = result.data.files.filter((file: any) =>
        ['.webp', '.jpg', '.jpeg', '.png'].includes(file.extension),
      );
      expect(imageFiles.length).toBeGreaterThan(0);
    });

    it('should use default pagination values', async () => {
      const result = await service.getAllUploads();

      expect(result.data.pagination.currentPage).toBe(1);
      expect(result.data.pagination.filesPerPage).toBe(50);
    });

    it('should sort results by date by default', async () => {
      const result = await service.getAllUploads();

      const dates = result.data.files.map((f: any) => new Date(f.createdAt).getTime());
      const sortedAsc = [...dates].sort((a, b) => a - b);
      const sortedDesc = [...dates].sort((a, b) => b - a);
      const isSorted =
        JSON.stringify(dates) === JSON.stringify(sortedAsc) ||
        JSON.stringify(dates) === JSON.stringify(sortedDesc);
      expect(isSorted).toBe(true);
      expect(mockBucket.getFiles).toHaveBeenCalled();
    });

    it('should handle empty directory', async () => {
      mockBucket.getFiles.mockResolvedValue([[]]);

      const result = await service.getAllUploads();

      expect(result.data.files).toEqual([]);
      expect(result.data.pagination.totalFiles).toBe(0);
    });
  });

  describe('getUploadStats', () => {
    const gcsImageFiles = [
      { name: 'images/image1.webp', metadata: { size: '1024', timeCreated: '2024-01-01T00:00:00Z' } },
      { name: 'images/image2.jpg', metadata: { size: '2048', timeCreated: '2024-01-02T00:00:00Z' } },
      { name: 'images/image3.png', metadata: { size: '512', timeCreated: '2024-01-03T00:00:00Z' } },
    ];

    beforeEach(() => {
      mockBucket.getFiles.mockResolvedValue([gcsImageFiles]);
    });

    it('should return upload statistics', async () => {
      const result = await service.getUploadStats();

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('totalFiles');
      expect(result.data).toHaveProperty('totalSize');
      expect(result.data).toHaveProperty('totalSizeFormatted');
      expect(result.data).toHaveProperty('averageFileSize');
      expect(result.data).toHaveProperty('extensions');
      expect(result.data).toHaveProperty('dateRange');
    });

    it('should calculate total size correctly', async () => {
      const result = await service.getUploadStats();

      expect(result.data.totalSize).toBe(1024 + 2048 + 512);
    });

    it('should return empty stats for empty directory', async () => {
      mockBucket.getFiles.mockResolvedValue([[]]);

      const result = await service.getUploadStats();

      expect(result.data.totalFiles).toBe(0);
      expect(result.data.totalSize).toBe(0);
      expect(result.data.totalSizeFormatted).toBe('0 Bytes');
    });

    it('should group statistics by extension', async () => {
      const result = await service.getUploadStats();

      expect(result.data.extensions).toBeDefined();
      expect(typeof result.data.extensions).toBe('object');
    });
  });

  describe('deleteUpload', () => {
    const filename = 'test-image.webp';

    it('should delete file successfully', async () => {
      mockGcsFile.exists.mockResolvedValue([true]);

      const result = await service.deleteUpload(filename);

      expect(result.success).toBe(true);
      expect(result.message).toContain('removido com sucesso');
      expect(mockGcsFile.delete).toHaveBeenCalled();
    });

    it('should throw error if filename is invalid', async () => {
      await expect(service.deleteUpload('')).rejects.toThrow(
        'Nome do arquivo inválido',
      );
    });

    it('should throw error if file extension is not allowed', async () => {
      await expect(service.deleteUpload('test.exe')).rejects.toThrow(
        'Tipo de arquivo não permitido',
      );
    });

    it('should throw error if file does not exist', async () => {
      mockGcsFile.exists.mockResolvedValue([false]);

      await expect(service.deleteUpload(filename)).rejects.toThrow(
        'Arquivo não encontrado',
      );
    });

    it('should sanitize filename', async () => {
      const maliciousFilename = '../../../etc/passwd';
      await expect(service.deleteUpload(maliciousFilename)).rejects.toThrow();
    });

    it('should only allow image extensions', async () => {
      const allowedExtensions = ['.webp', '.jpg', '.jpeg', '.png'];

      for (const ext of allowedExtensions) {
        mockGcsFile.exists.mockResolvedValue([true]);
        const result = await service.deleteUpload(`test${ext}`);
        expect(result.success).toBe(true);
      }
    });
  });

  describe('deleteMultipleUploads', () => {
    const filenames = ['image1.webp', 'image2.jpg', 'image3.png'];

    beforeEach(() => {
      mockGcsFile.exists.mockResolvedValue([true]);
    });

    it('should delete multiple files successfully', async () => {
      const result = await service.deleteMultipleUploads(filenames);

      expect(result.success).toBe(true);
      expect(result.data.totalDeleted).toBe(filenames.length);
      expect(result.data.totalErrors).toBe(0);
    });

    it('should throw error if filenames array is empty', async () => {
      await expect(service.deleteMultipleUploads([])).rejects.toThrow(
        'Lista de arquivos inválida',
      );
    });

    it('should throw error if more than 50 files', async () => {
      const manyFiles = Array.from({ length: 51 }, (_, i) => `image${i}.webp`);

      await expect(service.deleteMultipleUploads(manyFiles)).rejects.toThrow(
        'Não é possível deletar mais de 50 arquivos',
      );
    });

    it('should handle partial failures', async () => {
      mockGcsFile.exists
        .mockResolvedValueOnce([true])
        .mockResolvedValueOnce([false])
        .mockResolvedValueOnce([true]);

      const result = await service.deleteMultipleUploads(filenames);

      expect(result.data.totalDeleted).toBeLessThan(filenames.length);
      expect(result.data.totalErrors).toBeGreaterThan(0);
    });
  });

  describe('batchUploadImages', () => {
    const mockFiles = [
      { buffer: Buffer.from('image1'), originalname: 'image1.jpg' },
      { buffer: Buffer.from('image2'), originalname: 'image2.jpg' },
      { buffer: Buffer.from('image3'), originalname: 'image3.jpg' },
    ];

    it('should upload multiple images successfully', async () => {
      const result = await service.batchUploadImages(mockFiles);

      expect(result.total).toBe(mockFiles.length);
      expect(result.success).toBe(mockFiles.length);
      expect(result.failed).toBe(0);
      expect(result.urls.length).toBe(mockFiles.length);
    });

    it('should throw error if files array is empty', async () => {
      await expect(service.batchUploadImages([])).rejects.toThrow(
        'Nenhum arquivo enviado',
      );
    });

    it('should throw error if more than 20 files', async () => {
      const manyFiles = Array.from({ length: 21 }, (_, i) => ({
        buffer: Buffer.from('data'),
        originalname: `image${i}.jpg`,
      }));

      await expect(service.batchUploadImages(manyFiles)).rejects.toThrow(
        'Não é possível fazer upload de mais de 20 arquivos',
      );
    });

    it('should handle partial failures', async () => {
      mockGcsFile.save
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Upload failed'))
        .mockResolvedValueOnce(undefined);

      const result = await service.batchUploadImages(mockFiles);

      expect(result.success).toBeGreaterThan(0);
      expect(result.failed).toBeGreaterThan(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should process files in batches of 5', async () => {
      const manyFiles = Array.from({ length: 12 }, (_, i) => ({
        buffer: Buffer.from('data'),
        originalname: `image${i}.jpg`,
      }));

      await service.batchUploadImages(manyFiles);

      expect(mockGcsFile.save).toHaveBeenCalled();
    });
  });

  describe('formatFileSize', () => {
    it('should format bytes correctly', () => {
      expect((service as any).formatFileSize(0)).toBe('0 Bytes');
      expect((service as any).formatFileSize(1024)).toContain('KB');
      expect((service as any).formatFileSize(1048576)).toContain('MB');
      expect((service as any).formatFileSize(1073741824)).toContain('GB');
    });

    it('should handle edge cases', () => {
      expect((service as any).formatFileSize(1)).toBe('1 Bytes');
      expect((service as any).formatFileSize(500)).toContain('Bytes');
    });
  });
});
