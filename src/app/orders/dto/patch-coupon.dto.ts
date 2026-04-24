import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class PatchCouponDto {
  @ApiPropertyOptional({ description: 'Código do cupom (DISCOUNT type)' })
  @IsOptional()
  @IsString()
  couponCode?: string;

  @ApiPropertyOptional({ description: 'Código do voucher' })
  @IsOptional()
  @IsString()
  voucherCode?: string;
}
