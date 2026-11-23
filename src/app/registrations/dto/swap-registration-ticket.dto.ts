import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsUUID, ValidateNested } from 'class-validator';

export class SwapProductItemDto {
  @ApiProperty({ description: 'Produto vinculado ao ingresso novo' })
  @IsUUID()
  productId: string;

  @ApiPropertyOptional({
    description: 'Opções escolhidas, 1 por variação do kit (obrigatório se o produto tiver variações)',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  variationIds?: string[] | null;

  @ApiPropertyOptional({ description: 'Legado = variationIds[0]' })
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
