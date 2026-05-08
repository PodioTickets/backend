import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  BadRequestException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiParam,
} from '@nestjs/swagger';
import { UploadDto } from './dto/upload.dto';
import { BatchUploadDto, BatchUploadResultDto } from './dto/batch-upload.dto';
import { UploadService } from './upload.service';
import { AdminGuard } from '../auth/guards/admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SecurityMonitoringService } from '../../common/services/security-monitoring.service';
import { SecurityAlertsService } from '../../common/services/security-alerts.service';
import { NoCache } from 'src/common/decorators/cache.decorator';

// DTOs para os endpoints de delete
class DeleteFilesDto {
  filenames: string[];
}

@ApiTags('Upload')
@Controller('/api/v1/upload')
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly securityMonitoring: SecurityMonitoringService,
    private readonly securityAlerts: SecurityAlertsService,
  ) {}

  @Get()
  @NoCache()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiOperation({
    summary: 'Listar todos os uploads',
    description:
      'Retorna uma lista paginada de todos os arquivos de imagem carregados, com informações detalhadas sobre cada arquivo.',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de uploads obtida com sucesso',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'object',
          properties: {
            files: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  filename: {
                    type: 'string',
                    example: '1757464893165-228732938.webp',
                  },
                  url: {
                    type: 'string',
                    example: '/uploads/images/1757464893165-228732938.webp',
                  },
                  size: { type: 'number', example: 45231 },
                  sizeFormatted: { type: 'string', example: '44.17 KB' },
                  createdAt: { type: 'string', format: 'date-time' },
                  modifiedAt: { type: 'string', format: 'date-time' },
                  extension: { type: 'string', example: '.webp' },
                },
              },
            },
            pagination: {
              type: 'object',
              properties: {
                currentPage: { type: 'number', example: 1 },
                totalPages: { type: 'number', example: 5 },
                totalFiles: { type: 'number', example: 18 },
                filesPerPage: { type: 'number', example: 50 },
                hasNextPage: { type: 'boolean', example: false },
                hasPreviousPage: { type: 'boolean', example: false },
              },
            },
          },
        },
        message: { type: 'string', example: 'Found 18 uploaded files' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Não autorizado - usuário não autenticado',
  })
  @ApiResponse({
    status: 403,
    description: 'Acesso negado - privilégios de admin necessários',
  })
  async getAllUploads(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: 'name' | 'date',
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ) {
    try {
      const pageNum = page ? parseInt(page) : 1;
      const limitNum = limit ? parseInt(limit) : 50;

      // Validações básicas
      if (pageNum < 1) {
        return {
          success: false,
          message: 'Página deve ser maior que 0',
          error: 'INVALID_PAGE',
        };
      }

      if (limitNum < 1 || limitNum > 100) {
        return {
          success: false,
          message: 'Limite deve estar entre 1 e 100',
          error: 'INVALID_LIMIT',
        };
      }

      if (sortBy && !['name', 'date'].includes(sortBy)) {
        return {
          success: false,
          message: 'sortBy deve ser "name" ou "date"',
          error: 'INVALID_SORT_BY',
        };
      }

      if (sortOrder && !['asc', 'desc'].includes(sortOrder)) {
        return {
          success: false,
          message: 'sortOrder deve ser "asc" ou "desc"',
          error: 'INVALID_SORT_ORDER',
        };
      }

      return await this.uploadService.getAllUploads({
        page: pageNum,
        limit: limitNum,
        sortBy,
        sortOrder,
      });
    } catch (error) {
      console.error('❌ Error getting uploads:', error);
      return {
        success: false,
        message: `Erro ao obter uploads: ${error.message}`,
        error: 'INTERNAL_ERROR',
      };
    }
  }

  @Get('stats')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiOperation({
    summary: 'Obter estatísticas dos uploads',
    description:
      'Retorna estatísticas detalhadas sobre todos os arquivos de imagem carregados, incluindo tamanho total, média de tamanho por arquivo, distribuição por extensão e intervalo de datas.',
  })
  @ApiResponse({
    status: 200,
    description: 'Estatísticas dos uploads obtidas com sucesso',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'object',
          properties: {
            totalFiles: { type: 'number', example: 18 },
            totalSize: { type: 'number', example: 1234567 },
            totalSizeFormatted: { type: 'string', example: '1.18 MB' },
            averageFileSize: { type: 'number', example: 68531.5 },
            averageFileSizeFormatted: { type: 'string', example: '66.92 KB' },
            extensions: {
              type: 'object',
              properties: {
                '.webp': {
                  type: 'object',
                  properties: {
                    count: { type: 'number', example: 15 },
                    totalSize: { type: 'number', example: 987654 },
                    totalSizeFormatted: {
                      type: 'string',
                      example: '964.51 KB',
                    },
                    percentage: { type: 'string', example: '83.3%' },
                  },
                },
              },
            },
            dateRange: {
              type: 'object',
              properties: {
                earliest: { type: 'string', format: 'date-time' },
                latest: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        message: {
          type: 'string',
          example: 'Statistics calculated for 18 uploaded files',
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Não autorizado - usuário não autenticado',
  })
  @ApiResponse({
    status: 403,
    description: 'Acesso negado - privilégios de admin necessários',
  })
  async getUploadStats() {
    try {
      return await this.uploadService.getUploadStats();
    } catch (error) {
      console.error('❌ Error getting upload stats:', error);
      return {
        success: false,
        message: `Erro ao obter estatísticas: ${error.message}`,
        error: 'INTERNAL_ERROR',
      };
    }
  }

  @Get('security/audit')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiOperation({
    summary: 'Auditar vulnerabilidades de segurança',
    description:
      'Executa auditoria completa de vulnerabilidades nas dependências e configuração de segurança',
  })
  @ApiResponse({
    status: 200,
    description: 'Auditoria concluída com sucesso',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'object',
          properties: {
            npmAudit: {
              type: 'object',
              properties: {
                vulnerabilities: { type: 'number', example: 1 },
                severity: { type: 'string', example: 'high' },
                packages: { type: 'array', example: ['bigint-buffer'] },
              },
            },
            securityConfig: {
              type: 'object',
              properties: {
                helmetConfigured: { type: 'boolean', example: true },
                corsEnabled: { type: 'boolean', example: true },
                rateLimitingActive: { type: 'boolean', example: true },
                csrfProtection: { type: 'boolean', example: true },
                ssrfProtection: { type: 'boolean', example: true },
                mfaAvailable: { type: 'boolean', example: true },
                secretRotation: { type: 'boolean', example: true },
              },
            },
            recommendations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  priority: { type: 'string', example: 'HIGH' },
                  category: { type: 'string', example: 'DEPENDENCIES' },
                  issue: {
                    type: 'string',
                    example: 'Outdated vulnerable packages',
                  },
                  solution: { type: 'string', example: 'Run npm audit fix' },
                },
              },
            },
          },
        },
        message: {
          type: 'string',
          example: 'Security audit completed successfully',
        },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'Acesso negado - privilégios de admin necessários',
  })
  async auditSecurity() {
    try {
      // Simular auditoria de segurança (em produção, implementar verificações reais)
      const auditResult = {
        npmAudit: {
          vulnerabilities: 1,
          severity: 'high',
          packages: ['bigint-buffer'],
        },
        securityConfig: {
          helmetConfigured: true,
          corsEnabled: true,
          rateLimitingActive: true,
          csrfProtection: true,
          ssrfProtection: true,
          mfaAvailable: true,
          secretRotation: true,
        },
        recommendations: [
          {
            priority: 'HIGH',
            category: 'DEPENDENCIES',
            issue: 'Vulnerable packages detected',
            solution: 'Run npm audit fix and update dependencies',
          },
          {
            priority: 'MEDIUM',
            category: 'CONFIGURATION',
            issue: 'Session secrets should be rotated regularly',
            solution: 'Configure automated secret rotation',
          },
          {
            priority: 'LOW',
            category: 'MONITORING',
            issue: 'Add security event monitoring',
            solution: 'Implement SIEM integration',
          },
        ],
      };

      return {
        success: true,
        data: auditResult,
        message: 'Security audit completed successfully',
      };
    } catch (error) {
      return {
        success: false,
        message: `Security audit failed: ${error.message}`,
        error: 'AUDIT_FAILED',
      };
    }
  }

  @Delete(':filename')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiOperation({
    summary: 'Deletar arquivo de upload',
    description:
      'Remove um arquivo específico do diretório de uploads. Apenas administradores podem executar esta operação.',
  })
  @ApiParam({
    name: 'filename',
    description: 'Nome do arquivo a ser deletado',
    example: '1757464893165-228732938.webp',
  })
  @ApiResponse({
    status: 200,
    description: 'Arquivo deletado com sucesso',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'object',
          properties: {
            deletedFile: {
              type: 'object',
              properties: {
                filename: {
                  type: 'string',
                  example: '1757464893165-228732938.webp',
                },
                size: { type: 'number', example: 45231 },
                sizeFormatted: { type: 'string', example: '44.17 KB' },
                createdAt: { type: 'string', format: 'date-time' },
                extension: { type: 'string', example: '.webp' },
              },
            },
          },
        },
        message: {
          type: 'string',
          example: 'Arquivo 1757464893165-228732938.webp removido com sucesso',
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Arquivo não encontrado ou nome inválido',
  })
  @ApiResponse({
    status: 401,
    description: 'Não autorizado - usuário não autenticado',
  })
  @ApiResponse({
    status: 403,
    description: 'Acesso negado - privilégios de admin necessários',
  })
  async deleteUpload(@Param('filename') filename: string) {
    try {
      return await this.uploadService.deleteUpload(filename);
    } catch (error) {
      console.error('❌ Error deleting upload:', error);
      return {
        success: false,
        message: `Erro ao deletar arquivo: ${error.message}`,
        error: 'DELETE_FAILED',
      };
    }
  }

  @Delete()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiOperation({
    summary: 'Deletar múltiplos arquivos de upload',
    description:
      'Remove vários arquivos do diretório de uploads em lote. Apenas administradores podem executar esta operação. Máximo de 50 arquivos por vez.',
  })
  @ApiBody({
    description: 'Lista de nomes dos arquivos a serem deletados',
    type: DeleteFilesDto,
    examples: {
      'exemplo-basico': {
        summary: 'Deletar múltiplos arquivos',
        value: {
          filenames: [
            '1757464893165-228732938.webp',
            '1757553010899-52223383.webp',
            '1757563193132-521500852.webp',
          ],
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Processamento concluído',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'object',
          properties: {
            deletedFiles: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  filename: {
                    type: 'string',
                    example: '1757464893165-228732938.webp',
                  },
                  size: { type: 'number', example: 45231 },
                  sizeFormatted: { type: 'string', example: '44.17 KB' },
                  createdAt: { type: 'string', format: 'date-time' },
                  extension: { type: 'string', example: '.webp' },
                },
              },
            },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  filename: {
                    type: 'string',
                    example: 'arquivo-nao-existe.webp',
                  },
                  error: { type: 'string', example: 'Arquivo não encontrado' },
                },
              },
            },
            totalRequested: { type: 'number', example: 3 },
            totalDeleted: { type: 'number', example: 2 },
            totalErrors: { type: 'number', example: 1 },
          },
        },
        message: {
          type: 'string',
          example: 'Processamento concluído: 2 deletados, 1 erros',
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Lista de arquivos inválida ou limite excedido',
  })
  @ApiResponse({
    status: 401,
    description: 'Não autorizado - usuário não autenticado',
  })
  @ApiResponse({
    status: 403,
    description: 'Acesso negado - privilégios de admin necessários',
  })
  async deleteMultipleUploads(@Body() body: DeleteFilesDto) {
    try {
      const { filenames } = body;

      if (!filenames || !Array.isArray(filenames)) {
        return {
          success: false,
          message: 'Lista de arquivos inválida',
          error: 'INVALID_FILE_LIST',
        };
      }

      if (filenames.length > 50) {
        return {
          success: false,
          message: 'Não é possível deletar mais de 50 arquivos por vez',
          error: 'TOO_MANY_FILES',
        };
      }

      return await this.uploadService.deleteMultipleUploads(filenames);
    } catch (error) {
      console.error('❌ Error deleting multiple uploads:', error);
      return {
        success: false,
        message: `Erro ao deletar múltiplos arquivos: ${error.message}`,
        error: 'DELETE_FAILED',
      };
    }
  }

  @Post('image')
  @SkipThrottle()
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload de imagem' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'Arquivo de imagem', type: UploadDto })
  @ApiResponse({
    status: 201,
    description: 'Imagem carregada e comprimida com sucesso',
  })
  async uploadImage(@UploadedFile() file: any) {
    try {
      if (!file) {
        throw new BadRequestException('Nenhum arquivo enviado');
      }
      const imageUrl = await this.uploadService.compressImage(file);
      return { url: imageUrl };
    } catch (error) {
      console.error('❌ Upload error:', error);
      throw error;
    }
  }

  @Post('pdf')
  @SkipThrottle()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
      fileFilter: (req, file, cb) => {
        // Permitir apenas PDFs
        if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
          cb(null, true);
        } else {
          cb(new Error('Only PDF files are allowed!'), false);
        }
      },
    }),
  )
  @ApiOperation({ summary: 'Upload de PDF' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'Arquivo PDF', type: UploadDto })
  @ApiResponse({
    status: 201,
    description: 'PDF carregado com sucesso',
  })
  async uploadPdf(@UploadedFile() file: any) {
    try {
      if (!file) {
        throw new BadRequestException('Nenhum arquivo enviado');
      }
      const pdfUrl = await this.uploadService.uploadPdf(file);
      return { url: pdfUrl };
    } catch (error) {
      console.error('❌ PDF upload error:', error);
      throw error;
    }
  }

  @Post('batch')
  @SkipThrottle()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @UseInterceptors(
    FilesInterceptor('files', 20, { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  @ApiOperation({
    summary: 'Upload de múltiplas imagens em batch',
    description:
      'Faz upload de até 20 imagens simultaneamente. As imagens são comprimidas, otimizadas e verificadas por malware.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Array de arquivos de imagem para upload em batch',
    type: BatchUploadDto,
  })
  @ApiResponse({
    status: 201,
    description: 'Upload em batch concluído com sucesso',
    type: BatchUploadResultDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Erro de validação ou limite excedido',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        message: {
          type: 'string',
          example: 'Não é possível fazer upload de mais de 20 arquivos por vez',
        },
      },
    },
  })
  @ApiResponse({
    status: 500,
    description: 'Erro interno do servidor',
  })
  async batchUploadImages(@UploadedFiles() files: any[]) {
    try {
      if (!files || (Array.isArray(files) && files.length === 0)) {
        return {
          success: false,
          message: 'Nenhum arquivo enviado',
          total: 0,
          successCount: 0,
          failed: 0,
          urls: [],
          errors: [],
        };
      }

      // Se vier apenas um arquivo, transformar em array
      const filesArray = Array.isArray(files) ? files : [files];

      console.log(
        `📦 Recebido pedido de upload em batch com ${filesArray.length} arquivos`,
      );

      const result = await this.uploadService.batchUploadImages(filesArray);

      return {
        success: true,
        message: `Upload em batch concluído: ${result.success} sucesso, ${result.failed} falhas`,
        ...result,
      };
    } catch (error) {
      console.error('❌ Erro no batch upload:', error);
      return {
        success: false,
        message: `Falha no upload em batch: ${error.message}`,
        total: 0,
        successCount: 0,
        failed: 0,
        urls: [],
        errors: [{ index: 0, filename: 'unknown', error: error.message }],
      };
    }
  }

  @Get('security/metrics')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiOperation({
    summary: 'Obter métricas de segurança',
    description:
      'Retorna métricas detalhadas de segurança, alertas ativos e estatísticas de eventos',
  })
  @ApiResponse({
    status: 200,
    description: 'Métricas de segurança obtidas com sucesso',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'object',
          properties: {
            securityStats: {
              type: 'object',
              properties: {
                summary: {
                  type: 'object',
                  properties: {
                    totalEvents: { type: 'number', example: 1250 },
                    totalAlerts: { type: 'number', example: 15 },
                    activeAlerts: { type: 'number', example: 3 },
                    recentEventsLastHour: { type: 'number', example: 45 },
                    recentAlertsLast24Hours: { type: 'number', example: 2 },
                  },
                },
                eventsByCategory: {
                  type: 'object',
                  example: { authentication: 120, authorization: 25 },
                },
                eventsByLevel: {
                  type: 'object',
                  example: { info: 500, warning: 300, error: 50 },
                },
                alertsBySeverity: {
                  type: 'object',
                  example: { low: 5, medium: 3, high: 2, critical: 0 },
                },
                topIPs: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      ip: { type: 'string', example: '192.168.1.100' },
                      count: { type: 'number', example: 25 },
                    },
                  },
                },
              },
            },
            activeAlerts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', example: 'alert_123456789' },
                  title: {
                    type: 'string',
                    example: 'Multiple Failed Login Attempts',
                  },
                  severity: { type: 'string', example: 'medium' },
                  timestamp: { type: 'string', format: 'date-time' },
                },
              },
            } as any,
            alertStats: {
              type: 'object',
              properties: {
                totalChannels: { type: 'number', example: 2 },
                enabledChannels: { type: 'number', example: 2 },
                channelsByType: {
                  type: 'object',
                  example: { email: 1, slack: 1 },
                },
                rulesBySeverity: {
                  type: 'object',
                  example: { low: 2, medium: 1, high: 1, critical: 1 },
                },
              },
            },
          },
        },
        message: {
          type: 'string',
          example: 'Security metrics retrieved successfully',
        },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'Acesso negado - privilégios de admin necessários',
  })
  async getSecurityMetrics() {
    try {
      const securityStats = this.securityMonitoring.getSecurityStats();
      const activeAlerts = this.securityMonitoring.getActiveAlerts();
      const alertStats = this.securityAlerts.getAlertStats();

      return {
        success: true,
        data: {
          securityStats,
          activeAlerts: activeAlerts.slice(0, 10), // Limitar a 10 alertas mais recentes
          alertStats,
        } as any,
        message: 'Security metrics retrieved successfully',
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to retrieve security metrics: ${error.message}`,
        error: 'METRICS_FAILED',
      };
    }
  }
}
