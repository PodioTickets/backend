import { IsString, IsOptional, IsInt, Min } from 'class-validator';
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
    description: 'Display order (default: last)',
    example: 0,
  })
  @Type(() => Number)
  order?: number;
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
  @Type(() => Number)
  order?: number;
}
