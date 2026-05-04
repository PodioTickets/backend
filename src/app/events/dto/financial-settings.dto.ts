import { IsNumber, IsInt, Min, Max, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateFinancialSettingsDto {
  @ApiProperty({ description: 'Percentual da taxa de 6% absorvido pelo organizador (0.0–6.0)', example: 3.0 })
  @IsNumber()
  @Min(0)
  @Max(6)
  organizerFeePercent: number;

  @ApiProperty({ description: 'Máximo de parcelas sem juros no cartão de crédito (1, 2 ou 3)', example: 2 })
  @IsInt()
  @IsIn([1, 2, 3])
  maxInstallments: number;
}
