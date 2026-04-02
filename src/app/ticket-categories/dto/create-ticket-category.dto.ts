import { IsString, IsOptional, IsInt, Min, IsArray, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTicketCategoryDto {
  @IsString()
  @ApiProperty({
    description: 'Category name',
    example: 'Corridas',
  })
  name: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Category description',
    example: 'Categoria para corridas de rua',
  })
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({
    description:
      'Display order within the event (0 = first). If omitted, appends after the last category.',
    example: 0,
  })
  @Type(() => Number)
  sortOrder?: number;
}

export class UpdateTicketCategoryDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({
    description: 'Display order within the event (0 = first).',
  })
  @Type(() => Number)
  sortOrder?: number;
}

/** Lista ordenada de IDs: índice no array = novo sortOrder (0, 1, 2, …). */
export class ReorderTicketCategoriesDto {
  @IsArray()
  @IsUUID(undefined, { each: true })
  @ApiProperty({
    description:
      'UUIDs de todas as categorias do evento, na ordem desejada (primeiro item = sortOrder 0)',
    type: [String],
  })
  categoryIds: string[];
}
