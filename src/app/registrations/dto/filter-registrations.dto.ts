import { IsOptional, IsEnum, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum RegistrationFilterStatus {
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
}

export class FilterRegistrationsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @ApiPropertyOptional({ description: 'Page number', example: 1, default: 1 })
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({ description: 'Items per page', example: 20, default: 20, maximum: 100 })
  limit?: number;

  @IsOptional()
  @IsEnum(RegistrationFilterStatus)
  @ApiPropertyOptional({
    description: 'Filter by status',
    enum: RegistrationFilterStatus,
    example: RegistrationFilterStatus.CONFIRMED,
  })
  status?: RegistrationFilterStatus;
}
