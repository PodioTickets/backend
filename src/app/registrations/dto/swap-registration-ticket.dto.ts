import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsUUID, ValidateNested } from 'class-validator';

export class SwapProductItemDto {
  @ApiProperty({ description: 'Produto vinculado ao ingresso novo' })
  @IsUUID()
  productId: string;

  @ApiPropertyOptional({ description: 'Variação escolhida (obrigatória se o produto tiver variações)' })
  @IsOptional()
  @IsUUID()
  variationId?: string | null;
}

/** Troca de ingresso pelo admin: ingresso novo + produtos escolhidos para ele. */
export class SwapRegistrationTicketDto {
  @ApiProperty({ description: 'Ingresso novo (mesmo evento)' })
  @IsUUID()
  ticketId: string;

  @ApiProperty({ type: [SwapProductItemDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SwapProductItemDto)
  products: SwapProductItemDto[];
}
