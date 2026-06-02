import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Query opcional do endpoint de cidades (escalabilidade p/ estados grandes).
 * - `search`: filtro por substring no nome (case/acento-insensível, aplicado no service).
 * - `limit`: teto de itens retornados (default no service = 1000).
 */
export class ListCitiesDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number) // query string → number (global ValidationPipe transform: true)
  @IsInt()
  @Min(1)
  @Max(5000)
  limit?: number;
}
