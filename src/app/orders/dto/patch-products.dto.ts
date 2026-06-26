import { IsArray, IsEmail, IsInt, IsOptional, IsUUID, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class OrderProductItemDto {
  @IsUUID()
  productId: string;

  @IsOptional()
  @IsUUID()
  variationId?: string;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsEmail()
  participantEmail: string;

  /**
   * Índice do slot (participante↔ingresso) ao qual o produto pertence. Canônico:
   * mesma ordem de `reservedTickets`/`participants` (categorias→tickets→qtd→avulsos).
   * Resolve o vínculo produto→inscrição quando 2 participantes têm o MESMO e-mail
   * (mesma pessoa em 2 ingressos) — o e-mail sozinho é ambíguo. Opcional p/
   * retrocompatibilidade: ausente → finalize cai no match por e-mail (legado).
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  participantIndex?: number;
}

export class PatchProductsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderProductItemDto)
  products: OrderProductItemDto[];
}
