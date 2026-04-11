import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
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

export class PayOrderDto {
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @IsOptional()
  @ValidateNested()
  @Type(() => CardDataDto)
  card?: CardDataDto;

  @IsOptional()
  @IsString()
  couponCode?: string;

  @IsOptional()
  @IsString()
  voucherCode?: string;
}
