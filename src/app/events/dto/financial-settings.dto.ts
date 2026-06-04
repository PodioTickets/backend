import { IsNumber, IsInt, Min, IsIn, IsOptional, IsArray, ArrayMinSize, ArrayUnique } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Métodos configuráveis na tela financeira (CRYPTO/BOLETO existem no enum mas não são processados no checkout). */
export const CONFIGURABLE_PAYMENT_METHODS = ['PIX', 'DEBIT_CARD', 'CREDIT_CARD'] as const;
export type ConfigurablePaymentMethod = (typeof CONFIGURABLE_PAYMENT_METHODS)[number];

// ──────────────── Request ────────────────

export class UpdateFinancialSettingsDto {
  @ApiProperty({ description: 'Percentual da taxa absorvido pelo organizador (0.0–100.0). Omitir mantém o valor atual. Travado após a publicação (409).', example: 3.0, minimum: 0, required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  organizerFeePercent?: number;

  @ApiProperty({ description: 'Percentual da taxa repassado ao participante (0.0–100.0). Omitir mantém o valor atual. Travado após a publicação (409).', example: 3.0, minimum: 0, required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  participantFeePercent?: number;

  @ApiProperty({ description: 'Número máximo de parcelas sem juros aceitas no cartão de crédito. Omitir mantém o valor atual.', example: 2, enum: [1, 2, 3], required: false })
  @IsOptional()
  @IsInt()
  @IsIn([1, 2, 3])
  maxInstallments?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  totalFee?: number;

  @ApiProperty({
    description: 'Formas de pagamento aceitas no checkout (mínimo 1). Omitir mantém o valor atual.',
    example: ['PIX', 'CREDIT_CARD'],
    isArray: true,
    enum: CONFIGURABLE_PAYMENT_METHODS,
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(CONFIGURABLE_PAYMENT_METHODS, { each: true })
  acceptedPaymentMethods?: ConfigurablePaymentMethod[];
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
    description: 'Métodos de pagamento aceitos no checkout, configurados por evento (default: todos).',
    example: ['PIX', 'DEBIT_CARD', 'CREDIT_CARD'],
    isArray: true,
    type: String,
    enum: CONFIGURABLE_PAYMENT_METHODS,
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
