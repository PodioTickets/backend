import { IsArray, IsInt, IsOptional, IsUUID, Min, ValidateNested } from 'class-validator';
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
}

export class PatchProductsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderProductItemDto)
  products: OrderProductItemDto[];
}
