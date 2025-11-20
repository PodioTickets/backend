import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsPositive, Min } from 'class-validator';

export class SellItemDto {
  @ApiProperty({
    description: 'Quantidade do item a vender',
    example: 1,
    minimum: 1,
  })
  @IsInt()
  @IsPositive()
  @Min(1)
  quantity: number;
}
