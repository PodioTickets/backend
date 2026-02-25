import { IsOptional, IsEnum, IsArray, IsString, IsInt, Min, Max } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export enum DashboardPeriod {
  GERAL = 'geral',
  LAST_24H = '24h',
  LAST_7D = '7d',
  LAST_15D = '15d',
  LAST_1M = '1m',
  LAST_2M = '2m',
}

export class DashboardQueryDto {
  @IsOptional()
  @IsEnum(DashboardPeriod)
  period?: DashboardPeriod;

  @IsOptional()
  @Transform(({ value }) => {
    // Aceitar tanto ticketIds quanto ticketIds[]
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value === 'string') {
      return [value];
    }
    return value;
  })
  @IsArray()
  @IsString({ each: true })
  ticketIds?: string[];

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
