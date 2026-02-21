import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsArray,
  ValidateNested,
  Min,
  MaxLength,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProductVariationDto {
  @IsString()
  @ApiProperty({
    description: 'Variation name (e.g., "PP", "P", "M", "G")',
    example: 'M',
  })
  name: string;

  @IsNumber()
  @Min(0)
  @ApiProperty({
    description: 'Price for this variation',
    example: 50.0,
  })
  @Type(() => Number)
  price: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @ApiPropertyOptional({
    description: 'Stock quantity (0 = unlimited)',
    example: 100,
    default: 0,
  })
  @Type(() => Number)
  stock?: number;
}

export class CreateProductDto {
  @IsString()
  @MaxLength(25)
  @ApiProperty({
    description: 'Product name (max 25 characters)',
    example: 'Camiseta',
  })
  name: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Product image URL',
    example: '/uploads/images/product.jpg',
  })
  image?: string;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({
    description: 'If true, product is included in ticket price',
    default: false,
  })
  isIncludedInTicket?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @ApiPropertyOptional({
    description: 'Base price (used when no variation selected)',
    default: 0,
  })
  @Type(() => Number)
  basePrice?: number;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({
    description: 'If true, participant must choose a variation',
    default: false,
  })
  isRequired?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ProductVariationDto)
  @ApiProperty({
    description: 'Product variations (sizes, colors, etc.)',
    type: [ProductVariationDto],
  })
  variations: ProductVariationDto[];
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MaxLength(25)
  name?: string;

  @IsOptional()
  @IsString()
  image?: string;

  @IsOptional()
  @IsBoolean()
  isIncludedInTicket?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  basePrice?: number;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductVariationDto)
  variations?: ProductVariationDto[];
}

export class FilterProductsDto {
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
