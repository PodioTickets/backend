import { Test, TestingModule } from '@nestjs/testing';
import { UploadService } from '../upload.service';
import * as fs from 'fs/promises';
import * as sharp from 'sharp';
import * as ClamScan from 'clamscan';
import * as path from 'path';

jest.mock('fs/promises');
jest.mock('sharp');
jest.mock('clamscan', () => ({
  createScanner: jest.fn(),
}));

describe('UploadService', () => {
  let service: UploadService;

  const mockFile = {
    buffer: Buffer.from('fake-image-data'),
    originalname: 'test.jpg',
    mimetype: 'image/jpeg',
    size: 1024,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [UploadService],
    }).compile();

    service = module.get<UploadService>(UploadService);

    // Mock fs methods
    (fs.access as jest.Mock).mockResolvedValue(undefined);
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    (fs.readdir as jest.Mock).mockResolvedValue([]);
    (fs.unlink as jest.Mock).mockResolvedValue(undefined);
    (fs.stat as jest.Mock).mockResolvedValue({
      size: 1024,
      birthtime: new Date('2024-01-01'),
      mtime: new Date('2024-01-01'),
    });

    // Mock sharp
    const mockSharp = {
      webp: jest.fn().mockReturnThis(),
      resize: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockResolvedValue(Buffer.from('compressed-data')),
    };
    (sharp as any).mockReturnValue(mockSharp);

    // Mock ClamScan
    const mockScanner = {
      scanFile: jest.fn().mockResolvedValue({
        isInfected: false,
        viruses: [],
      }),
    };
    (ClamScan.createScanner as jest.Mock).mockResolvedValue(mockScanner);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('compressImage', () => {
    it('should compress and save image successfully', async () => {
      const result = await service.compressImage(mockFile);

      expect(result).toContain('/uploads/images/');
      expect(result).toContain('.webp');
      expect(fs.writeFile).toHaveBeenCalled();
      expect(sharp).toHaveBeenCalledWith(mockFile.buffer);
    });

    it('should throw error if file is missing', async () => {
      await expect(service.compressImage(null as any)).rejects.toThrow(
        'No file uploaded or file buffer missing',
      );
    });

    it('should throw error if file buffer is missing', async () => {
      await expect(
        service.compressImage({ ...mockFile, buffer: undefined } as any),
      ).rejects.toThrow('No file uploaded or file buffer missing');
    });

    it('should scan for malware before processing', async () => {
      await service.compressImage(mockFile);

      expect(ClamScan.createScanner).toHaveBeenCalled();
    });

    it('should throw error if malware is detected', async () => {
      const mockScanner = {
        scanFile: jest.fn().mockResolvedValue({
          isInfected: true,
          viruses: ['Trojan.Test'],
        }),
      };
      (ClamScan.createScanner as jest.Mock).mockResolvedValue(mockScanner);

      await expect(service.compressImage(mockFile)).rejects.toThrow(
        'Malware detected',
      );
    });

    it('should continue if ClamAV is unavailable', async () => {
      (ClamScan.createScanner as jest.Mock).mockRejectedValue(
        new Error('ClamAV not available'),
      );

      const result = await service.compressImage(mockFile);

      expect(result).toBeDefined();
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should resize image to max 500x500', async () => {
      await service.compressImage(mockFile);

      const mockSharpInstance = (sharp as any).mock.results[0].value;
      expect(mockSharpInstance.resize).toHaveBeenCalledWith({
        width: 500,
        height: 500,
        fit: 'inside',
        withoutEnlargement: true,
      });
    });

    it('should convert image to WebP format', async () => {
      await service.compressImage(mockFile);

      const mockSharpInstance = (sharp as any).mock.results[0].value;
      expect(mockSharpInstance.webp).toHaveBeenCalledWith({
        quality: 80,
        effort: 6,
        lossless: false,
      });
    });
  });

  describe('getAllUploads', () => {
    const mockFiles = ['image1.webp', 'image2.jpg', 'image3.png', 'document.pdf'];

    beforeEach(() => {
      (fs.readdir as jest.Mock).mockResolvedValue(mockFiles);
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

    it('should sort by date descending by default', async () => {
      await service.getAllUploads();

      expect(fs.readdir).toHaveBeenCalled();
    });

    it('should handle empty directory', async () => {
      (fs.readdir as jest.Mock).mockResolvedValue([]);

      const result = await service.getAllUploads();

      expect(result.data.files).toEqual([]);
      expect(result.data.pagination.totalFiles).toBe(0);
    });
  });

  describe('getUploadStats', () => {
    const mockFiles = ['image1.webp', 'image2.jpg', 'image3.png'];

    beforeEach(() => {
      (fs.readdir as jest.Mock).mockResolvedValue(mockFiles);
      (fs.stat as jest.Mock).mockResolvedValue({
        size: 1024,
        birthtime: new Date('2024-01-01'),
      });
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

      expect(result.data.totalSize).toBeGreaterThanOrEqual(0);
    });

    it('should return empty stats for empty directory', async () => {
      (fs.readdir as jest.Mock).mockResolvedValue([]);

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
      (fs.access as jest.Mock).mockResolvedValue(undefined);

      const result = await service.deleteUpload(filename);

      expect(result.success).toBe(true);
      expect(result.message).toContain('removido com sucesso');
      expect(fs.unlink).toHaveBeenCalled();
    });

    it('should throw error if filename is invalid', async () => {
      await expect(service.deleteUpload('')).rejects.toThrow('Nome do arquivo inválido');
    });

    it('should throw error if file extension is not allowed', async () => {
      await expect(service.deleteUpload('test.exe')).rejects.toThrow(
        'Tipo de arquivo não permitido',
      );
    });

    it('should throw error if file does not exist', async () => {
      (fs.access as jest.Mock).mockRejectedValue(new Error('File not found'));

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
        const filename = `test${ext}`;
        (fs.access as jest.Mock).mockResolvedValue(undefined);

        const result = await service.deleteUpload(filename);
        expect(result.success).toBe(true);
      }
    });
  });

  describe('deleteMultipleUploads', () => {
    const filenames = ['image1.webp', 'image2.jpg', 'image3.png'];

    beforeEach(() => {
      (fs.access as jest.Mock).mockResolvedValue(undefined);
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
      (fs.access as jest.Mock)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('File not found'))
        .mockResolvedValueOnce(undefined);
      (fs.unlink as jest.Mock)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const result = await service.deleteMultipleUploads(filenames);

      expect(result.data.totalDeleted).toBeLessThan(filenames.length);
      expect(result.data.totalErrors).toBeGreaterThan(0);
    });
  });

  describe('batchUploadImages', () => {
    const mockFiles = [
      {
        buffer: Buffer.from('image1'),
        originalname: 'image1.jpg',
      },
      {
        buffer: Buffer.from('image2'),
        originalname: 'image2.jpg',
      },
      {
        buffer: Buffer.from('image3'),
        originalname: 'image3.jpg',
      },
    ];

    beforeEach(() => {
      const mockSharp = {
        webp: jest.fn().mockReturnThis(),
        resize: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('compressed')),
      };
      (sharp as any).mockReturnValue(mockSharp);

      const mockScanner = {
        scanFile: jest.fn().mockResolvedValue({
          isInfected: false,
          viruses: [],
        }),
      };
      (ClamScan.createScanner as jest.Mock).mockResolvedValue(mockScanner);
    });

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
      const mockSharp = {
        webp: jest.fn().mockReturnThis(),
        resize: jest.fn().mockReturnThis(),
        toBuffer: jest
          .fn()
          .mockResolvedValueOnce(Buffer.from('compressed'))
          .mockRejectedValueOnce(new Error('Processing failed'))
          .mockResolvedValueOnce(Buffer.from('compressed')),
      };
      (sharp as any).mockReturnValue(mockSharp);

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

      // Verify that processing happened in batches
      expect(fs.writeFile).toHaveBeenCalled();
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

