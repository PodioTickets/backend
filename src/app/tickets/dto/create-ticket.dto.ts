import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsArray,
  IsUUID,
  IsEnum,
  ValidateNested,
  Min,
  ArrayMinSize,
  ValidateIf,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class AgeLimitDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @ApiPropertyOptional({ description: 'Minimum age', example: 18 })
  @Type(() => Number)
  min?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @ApiPropertyOptional({ description: 'Maximum age', example: 65 })
  @Type(() => Number)
  max?: number;
}

export class TicketBatchDto {
  @IsNumber()
  @Min(1)
  @ApiProperty({ description: 'Quantity available in this batch', example: 100 })
  @Type(() => Number)
  quantity: number;

  @IsNumber()
  @Min(0)
  @ApiProperty({ description: 'Price for this batch', example: 50.0 })
  @Type(() => Number)
  price: number;

  @IsOptional()
  @IsDateString()
  @ApiPropertyOptional({ description: 'Batch start date (ISO 8601)', example: '2024-01-01T00:00:00Z' })
  startDate?: string;

  @IsOptional()
  @IsDateString()
  @ApiPropertyOptional({ description: 'Batch end date (ISO 8601)', example: '2024-12-31T23:59:59Z' })
  endDate?: string;
}

export class CreateTicketDto {
  @IsString()
  @ApiProperty({ description: 'Ticket name', example: 'Corrida 5KM' })
  name: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Category ID', example: 'uuid' })
  categoryId?: string;

  @IsString()
  @ApiProperty({
    description: 'Modality (value from template, e.g., "Corrida de rua")',
    example: 'Corrida de rua',
  })
  modality: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Distance', example: '5' })
  distance?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Distance unit', example: 'KM', default: 'KM' })
  distanceUnit?: string;

  @IsOptional()
  @IsEnum(['all', 'male', 'female'])
  @ApiPropertyOptional({ description: 'Gender restriction', enum: ['all', 'male', 'female'], example: 'all' })
  gender?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AgeLimitDto)
  @ApiPropertyOptional({ description: 'Age limits', type: AgeLimitDto })
  ageLimit?: AgeLimitDto;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TicketBatchDto)
  @ApiProperty({
    description: 'Price batches (at least one required)',
    type: [TicketBatchDto],
  })
  batches: TicketBatchDto[];

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'If ticket includes a kit', default: false })
  hasKit?: boolean;

  @ValidateIf((o) => o.hasKit === true)
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Kit ID (required if hasKit is true)' })
  kitId?: string;

  @ValidateIf((o) => o.hasKit === true && !o.kitId)
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  @ApiPropertyOptional({
    description: 'Product IDs (used when hasKit is true and no kitId provided)',
    type: [String],
  })
  productIds?: string[];
}

export class UpdateTicketDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  modality?: string;

  @IsOptional()
  @IsString()
  distance?: string;

  @IsOptional()
  @IsString()
  distanceUnit?: string;

  @IsOptional()
  @IsEnum(['all', 'male', 'female'])
  gender?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AgeLimitDto)
  ageLimit?: AgeLimitDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TicketBatchDto)
  batches?: TicketBatchDto[];

  @IsOptional()
  @IsBoolean()
  hasKit?: boolean;

  @IsOptional()
  @IsUUID()
  kitId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  productIds?: string[];
}

export class FilterTicketsDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}
