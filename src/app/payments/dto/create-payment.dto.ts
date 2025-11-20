import { IsString, IsEnum, IsOptional, IsNumber, Min, IsObject } from 'class-validator';
import { PaymentMethod } from '@prisma/client';

export class CreatePaymentDto {
  @IsString()
  registrationId: string;

  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class ProcessPaymentDto {
  @IsString()
  paymentId: string;

  @IsOptional()
  @IsString()
  transactionId?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class ConfirmPaymentDto {
  @IsString()
  paymentId: string;

  @IsOptional()
  @IsString()
  paymentMethodId?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

