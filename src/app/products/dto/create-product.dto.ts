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
  ValidateIf,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Opção de uma variação (grupo) do kit. Sem preço próprio no fluxo novo (vale o basePrice). */
export class ProductVariationGroupOptionDto {
  /** UUID da opção existente (preserva o id). Omitir para criar. */
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'UUID da opção existente (preserva o id). Omitir para criar.' })
  id?: string;

  @IsString()
  @MaxLength(255)
  @ApiProperty({ description: 'Nome da opção (ex.: "M")', example: 'M' })
  name: string;

  /** Ausente em opção existente = mantém o salvo; em opção nova = 0. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  @ApiPropertyOptional({ description: 'Preço legado da opção (centavos). Ausente = mantém o salvo / 0 em opção nova.' })
  price?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  @ApiPropertyOptional({ description: 'Limite de estoque da opção (0 = sem limite próprio)', default: 0 })
  stock?: number;

  /** Ignorado — o backend usa o índice do array. Aceito p/ o front poder ecoar. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sortOrder?: number;
}

/** Variação (pergunta) do kit, ex.: "Tamanho da camisa", com suas opções. */
export class ProductVariationGroupDto {
  /** UUID da variação existente (preserva o id). Omitir para criar. */
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'UUID da variação existente (preserva o id). Omitir para criar.' })
  id?: string;

  @IsString()
  @MaxLength(255)
  @ApiProperty({ description: 'Nome da variação (pergunta exibida)', example: 'Tamanho da camisa' })
  name: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ProductVariationGroupOptionDto)
  @ApiProperty({ type: [ProductVariationGroupOptionDto] })
  variations: ProductVariationGroupOptionDto[];

  /** Ignorado — o backend usa o índice do array. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sortOrder?: number;
}

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

  /**
   * Ordem de exibição (0-based). OPCIONAL — o backend usa o ÍNDICE do array recebido como
   * fonte de verdade (recomputa o sortOrder em create/update). Aceito aqui só para o front
   * poder ecoar o valor sem quebrar a validação (whitelist). O valor enviado é ignorado.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  @ApiPropertyOptional({
    description: 'Ordem de exibição (0-based). Opcional — o backend usa o índice do array.',
    minimum: 0,
  })
  sortOrder?: number;
}

export class CreateProductDto {
  @IsString()
  @MaxLength(255)
  @ApiProperty({
    description: 'Product name (max 255 characters)',
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
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @ApiPropertyOptional({
    description: 'Array de até 10 fotos (data URL ou URL pública). Omitido quando vazio.',
    type: [String],
  })
  images?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9)
  @Type(() => Number)
  @ApiPropertyOptional({
    description: 'Índice (0-based) da imagem principal dentro de images. Omitido quando há apenas 1 foto.',
    minimum: 0,
    maximum: 9,
  })
  primaryImageIndex?: number;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({
    description: 'If true, product is included in ticket price',
    default: false,
  })
  isIncludedInTicket?: boolean;

  /** Kit (seção de kits do ingresso) × produto avulso. Definido na criação; não muda depois. */
  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'true = kit; false = produto avulso', default: false })
  isKit?: boolean;

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

  /** Cliente antigo (1 variação). Dispensado quando `variationGroups` é enviado. */
  @ValidateIf((o) => o.variationGroups === undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ProductVariationDto)
  @ApiPropertyOptional({
    description: 'Product variations (sizes, colors, etc.). Legado — ignorado quando variationGroups é enviado.',
    type: [ProductVariationDto],
  })
  variations?: ProductVariationDto[];

  /** Kit com várias variações. Quando enviado, manda (vale sobre variationType/variations). `[]` = sem variação. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ProductVariationGroupDto)
  @ApiPropertyOptional({ type: [ProductVariationGroupDto] })
  variationGroups?: ProductVariationGroupDto[];

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
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  image?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  images?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9)
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

  /** Kit com várias variações. Quando enviado, manda (ids preservados; ausente = removido). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ProductVariationGroupDto)
  variationGroups?: ProductVariationGroupDto[];

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

  /**
   * Código de voucher do link de checkout (?voucher=CODE). Quando presente, o service valida
   * o voucher ANTES de listar — voucher já utilizado/expirado/inexistente devolve erro tipado
   * amigável (422) em vez do 400 genérico de whitelist. String vazia é tratada como ausente.
   */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined,
  )
  @IsString()
  @MaxLength(64)
  @ApiPropertyOptional({
    description: 'Voucher code from the checkout link. Validated before listing products.',
    example: 'FVFJ0MAO',
  })
  voucher?: string;
}
