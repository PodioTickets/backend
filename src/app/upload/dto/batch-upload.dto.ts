import { ApiProperty } from '@nestjs/swagger';

export class BatchUploadDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'string', format: 'binary' },
    description: 'Array de arquivos para upload em batch'
  })
  files: any[];
}

export class BatchUploadResultDto {
  @ApiProperty({
    description: 'Número total de arquivos enviados',
    example: 5
  })
  total: number;

  @ApiProperty({
    description: 'Número de uploads bem-sucedidos',
    example: 4
  })
  success: number;

  @ApiProperty({
    description: 'Número de uploads que falharam',
    example: 1
  })
  failed: number;

  @ApiProperty({
    description: 'URLs dos arquivos enviados com sucesso',
    type: [String],
    example: [
      'https://api.example.com/uploads/images/1703123456789-123456789.webp',
      'https://api.example.com/uploads/images/1703123456790-987654321.webp'
    ]
  })
  urls: string[];

  @ApiProperty({
    description: 'Erros ocorridos durante o upload',
    type: [Object],
    example: [
      {
        index: 2,
        filename: 'malware.exe',
        error: 'Arquivo suspeito detectado'
      }
    ]
  })
  errors: Array<{
    index: number;
    filename: string;
    error: string;
  }>;
}
