import { IsArray, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { DashboardPeriod } from '../dashboard-period.util';

export class DashboardRankingsQueryDto {
  @IsOptional()
  @IsEnum(DashboardPeriod)
  period?: DashboardPeriod;

  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return [value];
    return value;
  })
  @IsArray()
  @IsString({ each: true })
  ticketIds?: string[];

  // Paginação do ticketRanking (vendas agregadas por ingresso).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ticketRankingPage?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  ticketRankingLimit?: number;

  // Paginação do bloco `tickets` (lista de ingressos cadastrados — mesmo shape do /financial).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ticketsPage?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  ticketsLimit?: number;
}
