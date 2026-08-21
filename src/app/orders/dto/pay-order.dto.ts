import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';

export class CardDataDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  number: string;

  @IsString()
  @IsNotEmpty()
  expiry: string;

  @IsString()
  @IsNotEmpty()
  cvv: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  installments?: number;
}

export class CardTokenDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsString()
  @IsNotEmpty()
  brand: string;

  @IsOptional()
  @IsString()
  holder?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{3,4}$/, { message: 'Security code must be 3 or 4 digits' })
  securityCode?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  installments?: number;
}

export class ThreeDsAuthDto {
  @ApiProperty({ description: 'Cardholder Authentication Verification Value (base64)' })
  @IsString()
  @IsNotEmpty()
  cavv: string;

  @ApiProperty({ description: 'Electronic Commerce Indicator' })
  @IsString()
  @IsNotEmpty()
  eci: string;

  @ApiPropertyOptional({ description: 'Transaction identifier from 3DS v1 (Xid)' })
  @IsOptional()
  @IsString()
  xid?: string;

  @ApiPropertyOptional({ description: '3DS version ("1" or "2")', default: '2' })
  @IsOptional()
  @IsString()
  version?: string;

  @ApiPropertyOptional({ description: 'Reference ID from 3DS v2 authentication' })
  @IsOptional()
  @IsString()
  referenceId?: string;
}

export class PayOrderDto {
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @IsOptional()
  @ValidateNested()
  @Type(() => CardDataDto)
  card?: CardDataDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CardTokenDto)
  cardToken?: CardTokenDto;

  @ApiPropertyOptional({ description: '3DS authentication result — required for DEBIT_CARD (Cielo)' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ThreeDsAuthDto)
  threeDs?: ThreeDsAuthDto;

  @IsOptional()
  @IsString()
  couponCode?: string;

  @IsOptional()
  @IsString()
  voucherCode?: string;
}
