import {
  IsString,
  IsOptional,
  IsNumber,
  IsInt,
  Min,
  IsBoolean,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateModalityDto {
  @IsOptional()
  @IsUUID()
  @ApiProperty()
  templateId?: string; // ID do template de modalidade pré-setada (opcional)

  @IsString()
  @ApiProperty()
  name: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  description?: string;

  @IsNumber()
  @Min(0)
  @ApiProperty()
  @Type(() => Number)
  price: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @ApiPropertyOptional()
  @Type(() => Number)
  maxParticipants?: number;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional()
  @Type(() => Number)
  order?: number;
}

export class UpdateModalityDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  price?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  maxParticipants?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  order?: number;
}
