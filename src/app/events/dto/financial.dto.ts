import { IsOptional, IsEnum, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export enum FinancialPeriod {
  HOJE = 'hoje',
  LAST_7D = '7d',
  LAST_15D = '15d',
  LAST_1M = '1m',
  LAST_2M = '2m',
}

export class FinancialQueryDto {
  @IsOptional()
  @IsEnum(FinancialPeriod)
  period?: FinancialPeriod;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
