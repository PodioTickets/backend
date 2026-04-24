import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsBoolean,
  IsEnum,
  ValidateNested,
  IsEmail,
  IsDateString,
  Min,
  Max,
  IsNotEmpty,
  ValidateIf,
  IsDefined,
  Matches,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { CheckoutBillingAddressDto } from './checkout-billing-address.dto';

function isValidCpf(cpf: string): boolean {
  const digits = cpf.replace(/\D/g, '');
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false; // all same digit

  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(digits[i]) * (10 - i);
  let remainder = (sum * 10) % 11;
  if (remainder === 10 || remainder === 11) remainder = 0;
  if (remainder !== parseInt(digits[9])) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(digits[i]) * (11 - i);
  remainder = (sum * 10) % 11;
  if (remainder === 10 || remainder === 11) remainder = 0;
  return remainder === parseInt(digits[10]);
}

function IsValidCpf(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidCpf',
      target: (object as any).constructor,
      propertyName,
      options: { message: 'CPF inválido', ...validationOptions },
      validator: {
        validate(value: any) {
          if (typeof value !== 'string') return false;
          return isValidCpf(value);
        },
      },
    });
  };
}

export class CheckoutTicketDto {
  @IsString()
  @ApiProperty({ description: 'Ticket ID', example: 'uuid' })
  ticketId: string;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  @ApiProperty({ description: 'Quantity of tickets', example: 2 })
  quantity: number;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Batch ID (optional, will use active batch if not provided)', example: 'uuid' })
  batchId?: string;
}

export class CheckoutProductDto {
  @IsString()
  @ApiProperty({ description: 'Product ID', example: 'uuid' })
  productId: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Product variation ID', example: 'uuid' })
  variationId?: string;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  @ApiProperty({ description: 'Quantity', example: 1 })
  quantity: number;
}

export class CheckoutQuestionAnswerDto {
  @IsString()
  @IsNotEmpty()
  @ApiProperty({ description: 'Question ID', example: 'uuid' })
  questionId: string;

  @Transform(({ value }) => {
    // Converter strings "true"/"false" para boolean
    if (typeof value === 'string') {
      const lowerValue = value.toLowerCase().trim();
      if (lowerValue === 'true' || lowerValue === 'verdadeiro') return true;
      if (lowerValue === 'false' || lowerValue === 'falso') return false;
      // Tentar converter para número se possível
      const numValue = Number(value);
      if (!isNaN(numValue) && value.trim() !== '') return numValue;
    }
    return value;
  })
  @IsDefined({ message: 'answer must be defined' })
  @ApiProperty({ description: 'Answer (string, boolean, or number)', example: 'Resposta' })
  answer: string | boolean | number;
}

export class CheckoutParticipantDto {
  @IsString()
  @ApiProperty({ description: 'Participant name', example: 'João Silva' })
  name: string;

  @IsString()
  @IsValidCpf()
  @ApiProperty({ description: 'CPF (numbers only)', example: '12345678900' })
  cpf: string;

  @IsEmail()
  @ApiProperty({ description: 'Email', example: 'joao@example.com' })
  email: string;

  @IsDateString()
  @ApiProperty({ description: 'Birth date (ISO 8601)', example: '1990-01-01' })
  birthDate: string;

  @IsString()
  @ApiProperty({ description: 'Phone', example: '11999999999' })
  phone: string;

  @IsOptional()
  @Transform(({ value }) => {
    // Converter strings vazias em undefined
    if (value === '' || value === null) return undefined;
    // Mapear valores comuns do frontend para o enum
    const genderMap: Record<string, string> = {
      'Masculino': 'MALE',
      'Feminino': 'FEMALE',
      'Outro': 'OTHER',
      'Prefiro não informar': 'PREFER_NOT_TO_SAY',
    };
    return genderMap[value] || value;
  })
  @IsEnum(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'], {
    message: 'gender must be one of: MALE, FEMALE, OTHER, PREFER_NOT_TO_SAY',
  })
  @ApiPropertyOptional({ 
    description: 'Gender', 
    enum: ['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'],
    example: 'MALE'
  })
  gender?: string;

  @IsOptional()
  @Transform(({ value }) => (value === '' || value === null ? undefined : value))
  @IsString()
  @ApiPropertyOptional({ description: 'Emergency contact name', example: 'Maria Silva' })
  emergencyContactName?: string;

  @IsOptional()
  @Transform(({ value }) => (value === '' || value === null ? undefined : value))
  @IsString()
  @ApiPropertyOptional({ description: 'Emergency phone', example: '11988888888' })
  emergencyPhone?: string;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Has emergency contact', default: false })
  hasEmergencyContact?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CheckoutQuestionAnswerDto)
  @ApiPropertyOptional({ description: 'Question answers', type: [CheckoutQuestionAnswerDto] })
  questionAnswers?: CheckoutQuestionAnswerDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CheckoutProductDto)
  @ApiPropertyOptional({ description: 'Products for this participant', type: [CheckoutProductDto] })
  products?: CheckoutProductDto[];
}

export class CheckoutCardDto {
  @IsString()
  @ApiProperty({ description: 'Cardholder name', example: 'JOÃO SILVA' })
  name: string;

  @IsString()
  @ApiProperty({ description: 'Card number (last 4 digits after validation)', example: '1234' })
  number: string;

  @IsString()
  @ApiProperty({ description: 'Expiry date (MM/YY)', example: '12/25' })
  expiry: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{3,4}$/, { message: 'CVV deve conter apenas 3 ou 4 dígitos numéricos' })
  @ApiProperty({ description: 'CVV (3 ou 4 dígitos)', example: '123' })
  cvv: string;

  @IsNumber()
  @Min(1)
  @Max(12)
  @Type(() => Number)
  @ApiProperty({ description: 'Number of installments (1-12)', example: 1 })
  installments: number;
}

export class CheckoutPaymentDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CheckoutCardDto)
  @ApiPropertyOptional({ description: 'Credit card data', type: CheckoutCardDto })
  card?: CheckoutCardDto;

  // PIX and Boleto data will be generated by payment gateway
}

export class ProcessCheckoutDto {
  @IsString()
  @ApiProperty({ description: 'Event ID', example: 'uuid' })
  eventId: string;

  @IsEnum(PaymentMethod)
  @ApiProperty({ description: 'Payment method', enum: PaymentMethod, example: PaymentMethod.PIX })
  paymentMethod: PaymentMethod;

  @ValidateNested()
  @Type(() => CheckoutPaymentDto)
  @ApiProperty({ description: 'Payment data', type: CheckoutPaymentDto })
  payment: CheckoutPaymentDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CheckoutTicketDto)
  @ApiProperty({ description: 'Selected tickets', type: [CheckoutTicketDto] })
  tickets: CheckoutTicketDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CheckoutParticipantDto)
  @ApiProperty({ description: 'Participants (one for each ticket)', type: [CheckoutParticipantDto] })
  participants: CheckoutParticipantDto[];

  @IsDefined({ message: 'billingAddress is required' })
  @ValidateNested()
  @Type(() => CheckoutBillingAddressDto)
  @ApiProperty({
    description: 'Endereço de cobrança confirmado antes do pagamento',
    type: CheckoutBillingAddressDto,
  })
  billingAddress: CheckoutBillingAddressDto;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Coupon code', example: 'PROMO2024' })
  couponCode?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Voucher code', example: 'ABC12345' })
  voucherCode?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Chave de idempotência para evitar pedidos duplicados (ex: UUID gerado pelo frontend)',
    example: 'frontend-uuid-v4',
  })
  idempotencyKey?: string;

  // serviceFee removido — calculado exclusivamente no servidor
}
