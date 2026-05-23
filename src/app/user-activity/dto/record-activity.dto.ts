import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserActivityCategory } from '@prisma/client';

/**
 * Limites alinhados com o `UserActivityService` (defesa em profundidade —
 * a barreira final é no service, mas validar cedo dá 400 explícito ao front
 * em vez de aceitar+dropar silenciosamente).
 */
export class ActivityEventDto {
  @ApiProperty({ enum: UserActivityCategory })
  @IsEnum(UserActivityCategory)
  category: UserActivityCategory;

  @ApiProperty({
    description:
      'Identificador curto/estável da ação. Ex: "page:event/:slug", "click:btn-buy-ticket". Não incluir IDs/UUIDs aqui.',
    maxLength: 200,
  })
  @IsString()
  @MaxLength(200)
  action: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  path?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  referrer?: string;

  @ApiPropertyOptional({
    description:
      'Payload livre. Chaves PII (password, cpf, cardNumber, token, etc.) são removidas automaticamente no backend.',
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class RecordActivityBatchDto {
  @ApiPropertyOptional({
    description:
      'UUID gerado pelo frontend (localStorage) para costurar jornada anônima → autenticada. Persiste entre navegações da mesma aba/perfil. Máx 64 chars.',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sessionId?: string;

  @ApiProperty({
    type: [ActivityEventDto],
    description: 'Batch de eventos (1–50). Acima de 50 → 400.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ActivityEventDto)
  events: ActivityEventDto[];
}
