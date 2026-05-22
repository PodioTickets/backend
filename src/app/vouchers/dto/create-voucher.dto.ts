import {
  IsString,
  IsOptional,
  IsNumber,
  IsInt,
  Min,
  IsEnum,
  IsArray,
  IsNotEmpty,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';
import { DocumentListItemDto } from '../../coupons/dto/create-coupon.dto';

export enum VoucherStatus {
  ACTIVE = 'ACTIVE',
  USED = 'USED',
  EXPIRED = 'EXPIRED',
  INACTIVE = 'INACTIVE',
}

export enum CpfListStatus {
  DISABLED = 'DISABLED',
  ENABLED = 'ENABLED',
}

export class CreateVoucherDto {
  @IsString()
  @IsNotEmpty()
  @ApiProperty({
    description: 'Name of the voucher batch',
    example: 'Corrida paranense',
  })
  name: string;

  @IsInt()
  @Min(1)
  @ApiProperty({
    description: 'Quantity of vouchers to create (each will have a unique code)',
    example: 10,
  })
  @Type(() => Number)
  quantity: number;

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
    example: '2026-12-31T23:59:59.999Z',
  })
  expiryDate?: string;

  @IsOptional()
  @IsEnum(CpfListStatus)
  @ApiPropertyOptional({
    description: 'CPF list status',
    enum: CpfListStatus,
    default: CpfListStatus.DISABLED,
  })
  cpfListStatus?: CpfListStatus;

  /**
   * LEGACY — ver Coupon.cpfList. Prefira `documentList` em clientes novos.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ApiPropertyOptional({
    description: 'LEGACY: Array of CPFs. Prefira `documentList`.',
    type: [String],
    example: ['12345678900', '98765432100'],
  })
  cpfList?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DocumentListItemDto)
  @ApiPropertyOptional({
    description: 'Lista de documentos elegíveis: [{type, numberClean}]',
    type: [DocumentListItemDto],
  })
  documentList?: DocumentListItemDto[];
}

export class UpdateVoucherDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

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
  expiryDate?: string;

  @IsOptional()
  @IsEnum(CpfListStatus)
  cpfListStatus?: CpfListStatus;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cpfList?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DocumentListItemDto)
  documentList?: DocumentListItemDto[];

  @IsOptional()
  @IsEnum(VoucherStatus)
  status?: VoucherStatus;
}

export class FilterVouchersDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsEnum(VoucherStatus)
  status?: VoucherStatus;
}
