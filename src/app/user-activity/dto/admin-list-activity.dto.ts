import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserActivityCategory, UserActivitySource } from '@prisma/client';

/**
 * Filtros pra listagem admin de UserActivityLog. Todos opcionais —
 * sem filtro retorna feed cronológico decrescente.
 *
 * Combinações de filtros usam AND. Para múltiplas categorias ou sources,
 * o cliente faz N requests (raro caso).
 */
export class AdminUserActivityListQueryDto {
  @ApiPropertyOptional({
    enum: UserActivityCategory,
    description: 'Filtra por categoria do evento.',
  })
  @IsOptional()
  @IsEnum(UserActivityCategory)
  category?: UserActivityCategory;

  @ApiPropertyOptional({
    enum: UserActivitySource,
    description: 'Filtra pela origem do registro (FRONTEND/BACKEND/WEBHOOK).',
  })
  @IsOptional()
  @IsEnum(UserActivitySource)
  source?: UserActivitySource;

  @ApiPropertyOptional({
    description: 'ID exato do usuário autor do evento.',
  })
  @IsOptional()
  @IsUUID('4')
  userId?: string;

  @ApiPropertyOptional({
    description:
      'Substring case-insensitive em firstName/lastName/email do usuário. Eventos anônimos (sem userId) são excluídos quando informado.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  userSearch?: string;

  @ApiPropertyOptional({
    description:
      'Costura jornada anônima→autenticada. Lookup exato (não substring).',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sessionId?: string;

  @ApiPropertyOptional({
    description:
      'IP exato (ex: "187.45.10.2"). Útil pra forense de bot/abuso.',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ip?: string;

  @ApiPropertyOptional({
    description: 'Substring case-insensitive no campo action.',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({
    description: 'Data/hora inicial (ISO 8601). Inclusivo.',
  })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({
    description: 'Data/hora final (ISO 8601). Inclusivo até 23:59:59.999 UTC.',
  })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({ description: 'Página (default 1)', example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: 'Itens por página (default 20, máx. 100)',
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
