import { IsNumber, IsInt, Min, IsIn, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// ──────────────── Request ────────────────

export class UpdateFinancialSettingsDto {
  @ApiProperty({ description: 'Percentual da taxa absorvido pelo organizador (0.0–100.0).', example: 3.0, minimum: 0 })
  @IsNumber()
  @Min(0)
  organizerFeePercent: number;

  @ApiProperty({ description: 'Percentual da taxa repassado ao participante (0.0–100.0).', example: 3.0, minimum: 0 })
  @IsNumber()
  @Min(0)
  participantFeePercent: number;

  @ApiProperty({ description: 'Número máximo de parcelas sem juros aceitas no cartão de crédito.', example: 2, enum: [1, 2, 3] })
  @IsInt()
  @IsIn([1, 2, 3])
  maxInstallments: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  totalFee?: number;
}

// ──────────────── Response ────────────────

export class FinancialSettingsResponseDto {
  @ApiProperty({ description: 'UUID do evento', example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  eventId: string;

  @ApiProperty({ description: 'Percentual da taxa absorvido pelo organizador (0.0–6.0)', example: 3.0 })
  organizerFeePercent: number;

  @ApiProperty({ description: 'Percentual da taxa repassado ao participante (0.0–100.0).', example: 3.0 })
  participantFeePercent: number;

  @ApiProperty({ description: 'Número máximo de parcelas sem juros no cartão', example: 2, enum: [1, 2, 3] })
  maxInstallments: number;

  @ApiProperty({
    description: 'Métodos de pagamento aceitos. Atualmente fixos — todos os eventos aceitam PIX, débito e crédito.',
    example: ['PIX', 'DEBIT_CARD', 'CREDIT_CARD'],
    isArray: true,
    type: String,
    enum: ['PIX', 'DEBIT_CARD', 'CREDIT_CARD'],
  })
  acceptedPaymentMethods: string[];

  @ApiProperty({
    description: 'Data de bloqueio das configurações (ISO 8601). Preenchida quando o evento é publicado. Null enquanto não publicado.',
    example: '2025-05-01T12:00:00.000Z',
    nullable: true,
    type: String,
    format: 'date-time',
  })
  lockedAt: string | null;
}

export class FinancialSettingsDataWrapperDto {
  @ApiProperty({ type: FinancialSettingsResponseDto })
  data: FinancialSettingsResponseDto;
}

export class FinancialSettingsLockedErrorDto {
  @ApiProperty({ example: 'FINANCIAL_SETTINGS_LOCKED' })
  error: string;

  @ApiProperty({ example: 'As configurações financeiras não podem ser alteradas após a publicação do evento.' })
  message: string;
}
