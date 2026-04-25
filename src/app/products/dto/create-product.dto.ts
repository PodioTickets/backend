import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsArray,
  ValidateNested,
  Min,
  Max,
  MaxLength,
  ArrayMinSize,
  ArrayMaxSize,
  IsInt,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProductVariationDto {
  /** UUID da variação existente. Quando enviado, a variação é atualizada no lugar (preserva o ID). Omitir para criar uma nova variação. */
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description: 'UUID of the existing variation. When provided, the variation is updated in place (ID is preserved). Omit to create a new variation.',
  })
  id?: string;

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
    description: 'Imagem principal (backward-compat). Equivalente a images[primaryImageIndex].',
    example: '/uploads/images/product.jpg',
  })
  image?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsString({ each: true })
  @ApiPropertyOptional({
    description: 'Array de até 5 fotos (data URL ou URL pública). Omitido quando vazio.',
    type: [String],
  })
  images?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  @Type(() => Number)
  @ApiPropertyOptional({
    description: 'Índice (0-based) da imagem principal dentro de images. Omitido quando há apenas 1 foto.',
    minimum: 0,
    maximum: 4,
  })
  primaryImageIndex?: number;

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

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Variation type/name (e.g., "Tamanhos", "Cores")',
    example: 'Tamanhos',
  })
  variationType?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ProductVariationDto)
  @ApiProperty({
    description: 'Product variations (sizes, colors, etc.)',
    type: [ProductVariationDto],
  })
  variations: ProductVariationDto[];

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({
    description:
      'If true, the participant may change the chosen variation after purchase within variationEditDeadlineDays before the event.',
    default: false,
  })
  buyerVariationEditAllowed?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  @ApiPropertyOptional({
    description:
      'Calendar days before the event until variation change is allowed. Ignored (stored as 0) when buyerVariationEditAllowed is false; default 30 when allowed and omitted.',
    minimum: 0,
    maximum: 9999,
  })
  @Type(() => Number)
  variationEditDeadlineDays?: number;
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MaxLength(25)
  name?: string;

  @IsOptional()
  @IsString()
  image?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsString({ each: true })
  images?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  @Type(() => Number)
  primaryImageIndex?: number;

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
  @IsString()
  variationType?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductVariationDto)
  variations?: ProductVariationDto[];

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({
    description:
      'If true, the participant may change the chosen variation after purchase within variationEditDeadlineDays before the event.',
  })
  buyerVariationEditAllowed?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  @ApiPropertyOptional({
    description:
      'Calendar days before the event until variation change is allowed. Use 0 when buyerVariationEditAllowed is false.',
    minimum: 0,
    maximum: 9999,
  })
  @Type(() => Number)
  variationEditDeadlineDays?: number;
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
