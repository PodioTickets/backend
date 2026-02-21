import { IsString, IsOptional, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateModalityGroupDto {
  @IsString()
  @ApiProperty({
    description: 'Group name',
    example: 'Corridas',
  })
  name: string;

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

export class UpdateModalityGroupDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  order?: number;
}
