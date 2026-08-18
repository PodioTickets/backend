import {
  IsEnum,
  IsIn,
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

export class MpDebitDto {
  @ApiProperty({ description: 'Card token gerado no browser via MercadoPago.js V2' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({
    description:
      'payment_method_id de débito/pré-pago do MP (debvisa, debmaster, debelo, elo, visa, master...)',
  })
  @IsString()
  // Só valida a FORMA (id minúsculo do MP). A validação SEMÂNTICA — se o id é
  // realmente débito/pré-pago — fica no MercadoPagoService.createDebitPayment,
  // que confere contra a lista de métodos ATIVOS da conta (fail-closed). Ids de
  // pré-pago são "crus" (elo/visa/master) e não passavam no antigo /^deb[a-z]+$/.
  @Matches(/^[a-z][a-z0-9_]{1,31}$/, { message: 'paymentMethodId deve ser um método de débito do Mercado Pago' })
  paymentMethodId: string;

  @ApiPropertyOptional({
    description:
      'payment_type_id do BIN lookup, repassado à Orders API. SÓ débito/pré-pago — credit_card é rejeitado (cobraria crédito como débito).',
    enum: ['debit_card', 'prepaid_card'],
  })
  @IsOptional()
  @IsIn(['debit_card', 'prepaid_card'], {
    message: 'paymentMethodType deve ser debit_card ou prepaid_card',
  })
  paymentMethodType?: 'debit_card' | 'prepaid_card';

  @ApiPropertyOptional({
    description:
      'CPF do TITULAR do cartão (11 dígitos) — vai no payer.identification do MP. Sem ele o risco recusa (cc_rejected_high_risk).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{11}$/, { message: 'holderCpf deve ter 11 dígitos' })
  holderCpf?: string;

  @ApiPropertyOptional({ description: 'Device fingerprint (MP_DEVICE_SESSION_ID) — melhora aprovação' })
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiPropertyOptional({ description: 'Nome impresso no cartão (exibição no recibo)' })
  @IsOptional()
  @IsString()
  holderName?: string;
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

  @ApiPropertyOptional({ description: '3DS authentication result — required for DEBIT_CARD (fluxo legado Cielo)' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ThreeDsAuthDto)
  threeDs?: ThreeDsAuthDto;

  @ApiPropertyOptional({
    description: 'Débito via Mercado Pago: card token + payment_method_id. Quando o MP está habilitado, substitui card/threeDs no DEBIT_CARD.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MpDebitDto)
  mpDebit?: MpDebitDto;

  @IsOptional()
  @IsString()
  couponCode?: string;

  @IsOptional()
  @IsString()
  voucherCode?: string;
}
