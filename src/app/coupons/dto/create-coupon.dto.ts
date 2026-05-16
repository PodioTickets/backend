import {
  IsString,
  IsOptional,
  IsNumber,
  IsInt,
  Min,
  Max,
  IsEnum,
  IsArray,
  IsBoolean,
  Matches,
  MaxLength,
  ValidateIf,
  IsNotEmpty,
  IsUUID,
  IsPositive,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export enum CouponType {
  DISCOUNT = 'DISCOUNT',
  QUANTITY = 'QUANTITY',
  AGE = 'AGE',
}

export enum CouponDiscountType {
  PERCENTAGE = 'PERCENTAGE',
  FIXED = 'FIXED',
}

export enum CouponStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  EXPIRED = 'EXPIRED',
}

export enum CpfListStatus {
  DISABLED = 'DISABLED',
  ENABLED = 'ENABLED',
}

export class CreateCouponDto {
  @ValidateIf((o) => o.couponType === CouponType.DISCOUNT)
  @IsNotEmpty()
  @IsString()
  @MaxLength(25)
  @Matches(/^[A-Za-z0-9]+$/, {
    message: 'Code must contain only letters and numbers, no spaces',
  })
  @ApiPropertyOptional({
    description: 'Coupon code (required for DISCOUNT, optional for QUANTITY and AGE. Max 25 characters, letters and numbers only)',
    example: 'PROMO2024',
  })
  code?: string;

  @IsEnum(CouponType)
  @ApiProperty({
    description: 'Type of coupon',
    enum: CouponType,
    example: CouponType.DISCOUNT,
  })
  couponType: CouponType;

  @IsEnum(CouponDiscountType)
  @ApiProperty({
    description: 'Discount type',
    enum: CouponDiscountType,
    example: CouponDiscountType.PERCENTAGE,
  })
  type: CouponDiscountType;

  @IsNumber()
  @Min(0)
  @ValidateIf((o) => o.type === CouponDiscountType.PERCENTAGE)
  @Max(100)
  @ApiProperty({
    description: 'Discount value (if PERCENTAGE, max 100)',
    example: 10,
  })
  @Type(() => Number)
  value: number;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Internal note',
    example: 'Promoção de lançamento',
  })
  note?: string;

  @IsOptional()
  @ApiPropertyOptional({
    description: "Applies to 'all' (string) or array of ticket IDs",
    oneOf: [
      { type: 'string', example: 'all' },
      { type: 'array', items: { type: 'string' }, example: ['ticket-id-1', 'ticket-id-2'] },
    ],
  })
  appliesTo?: string | string[];

  @IsOptional()
  @IsDateString()
  @ApiPropertyOptional({
    description: 'Expiry date (ISO 8601)',
    example: '2024-12-31T23:59:59Z',
  })
  expiryDate?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @ApiPropertyOptional({
    description: 'Minimum cart value',
    example: 100.0,
  })
  @Type(() => Number)
  minCartValue?: number;

  @IsOptional()
  @IsEnum(CpfListStatus)
  @ApiPropertyOptional({
    description: 'CPF list status',
    enum: CpfListStatus,
    default: CpfListStatus.DISABLED,
  })
  cpfListStatus?: CpfListStatus;

  @ValidateIf((o) => o.cpfListStatus === CpfListStatus.ENABLED)
  @IsNotEmpty()
  @IsArray()
  @IsString({ each: true })
  @ApiPropertyOptional({
    description: 'Array of CPFs (only if cpfListStatus is ENABLED)',
    type: [String],
    example: ['12345678900', '98765432100'],
  })
  cpfList?: string[];

  // Campos específicos para QUANTITY
  @ValidateIf((o) => o.couponType === CouponType.QUANTITY)
  @IsNotEmpty()
  @IsInt()
  @Min(1)
  @ApiPropertyOptional({
    description: 'Minimum quantity (required if couponType is QUANTITY)',
    example: 3,
  })
  @Type(() => Number)
  minQuantity?: number;

  // Campos específicos para AGE (legado — use minAge/maxAge)
  @IsOptional()
  @IsEnum(['MIN', 'MAX'])
  @ApiPropertyOptional({
    description: 'Age rule (legacy)',
    enum: ['MIN', 'MAX'],
    example: 'MIN',
  })
  ageRule?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Age value (legacy)',
    example: '9 anos',
  })
  ageValue?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  @ApiPropertyOptional({
    description: 'Minimum age in years (inclusive)',
    example: 18,
  })
  @Type(() => Number)
  minAge?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  @ApiPropertyOptional({
    description: 'Maximum age in years (inclusive)',
    example: 65,
  })
  @Type(() => Number)
  maxAge?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  @ApiPropertyOptional({
    description: 'Número máximo de vezes que o cupom pode ser usado',
    example: 100,
  })
  @Type(() => Number)
  maxUsage?: number;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({
    description: 'Se true, o desconto também incide sobre os produtos adicionais (kits/extras) do pedido. Default: false.',
    default: false,
  })
  applyToProducts?: boolean;
}

export class UpdateCouponDto {
  @IsOptional()
  @IsString()
  @MaxLength(25)
  @Matches(/^[A-Za-z0-9]+$/, {
    message: 'Code must contain only letters and numbers, no spaces',
  })
  code?: string;

  @IsOptional()
  @IsEnum(CouponType)
  couponType?: CouponType;

  @IsOptional()
  @IsEnum(CouponDiscountType)
  type?: CouponDiscountType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @ValidateIf((o) => o.type === CouponDiscountType.PERCENTAGE)
  @Max(100)
  @Type(() => Number)
  value?: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  appliesTo?: string | string[];

  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  minCartValue?: number;

  @IsOptional()
  @IsEnum(CpfListStatus)
  cpfListStatus?: CpfListStatus;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cpfList?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  minQuantity?: number;

  @IsOptional()
  @IsEnum(['MIN', 'MAX'])
  ageRule?: string;

  @IsOptional()
  @IsString()
  ageValue?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  minAge?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  maxAge?: number;

  @IsOptional()
  @IsEnum(CouponStatus)
  status?: CouponStatus;

  @IsOptional()
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  maxUsage?: number;

  @IsOptional()
  @IsBoolean()
  applyToProducts?: boolean;
}

export class FilterCouponsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsEnum(CouponStatus)
  status?: CouponStatus;
}
