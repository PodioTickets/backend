import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, Matches } from 'class-validator';
// import { ItemRarity, ItemType, ItemSource } from '@prisma/client'; // Removed - not in schema

export class ItemDto {
  @ApiProperty({
    description: 'ID único do item',
    example: 'cmfewspvf0000bqbgfeee6kux',
  })
  id: string;

  @ApiProperty({
    description: 'Nome do item',
    example: '0.5 SOL',
  })
  name: string;

  @ApiProperty({
    description: 'Descrição do item',
    example: 'Moeda digital Solana',
    required: false,
  })
  description?: string;

  @ApiProperty({
    description: 'URL da imagem do item',
    example: 'https://example.com/image.png',
    required: false,
  })
  imageUrl?: string;

  // @ApiProperty({
  //   description: 'Tipo do item',
  //   enum: ItemType,
  //   example: 'SOL',
  // })
  // type: ItemType;

  // @ApiProperty({
  //   description: 'Raridade do item',
  //   enum: ItemRarity,
  //   example: 'RARE',
  // })
  // rarity: ItemRarity;

  @ApiProperty({
    description: 'Valor do item (em SOL ou USD dependendo do tipo)',
    example: 0.5,
    required: false,
  })
  value?: number;

  @ApiProperty({
    description: 'Metadados adicionais do item (JSON)',
    example: { size: 'M', color: 'black' },
    required: false,
  })
  metadata?: any;

  @ApiProperty({
    description: 'Se o item está ativo',
    example: true,
  })
  isActive: boolean;
}

export class UserItemDto {
  @ApiProperty({
    description: 'ID único do item no inventário do usuário',
    example: 'cmfewspvf0000bqbgfeee6kux',
  })
  id: string;

  @ApiProperty({
    description: 'Quantidade do item no inventário',
    example: 3,
  })
  quantity: number;

  // @ApiProperty({
  //   description: 'Fonte de onde o item foi adquirido',
  //   enum: ItemSource,
  //   example: 'LOOTBOX',
  // })
  // source: ItemSource;

  @ApiProperty({
    description: 'Data de aquisição do item',
    example: '2025-09-11T10:30:00.000Z',
  })
  acquiredAt: Date;

  @ApiProperty({
    description: 'Dados do item',
    type: () => ItemDto,
  })
  item: ItemDto;
}

export class UserItemsResponseDto {
  @ApiProperty({
    description: 'Lista de itens do usuário',
    type: [UserItemDto],
  })
  items: UserItemDto[];

  @ApiProperty({
    description: 'Número total de itens diferentes',
    example: 15,
  })
  total: number;

  @ApiProperty({
    description: 'Número total de unidades de todos os itens',
    example: 42,
  })
  totalQuantity: number;
}

export class SellItemDataDto {
  @ApiProperty({
    description: 'ID da transação de saldo criada',
    example: 'cmfewspvf0000bqbgfeee6kux',
  })
  transactionId: string;

  @ApiProperty({
    description: 'Valor adicionado ao saldo do usuário',
    example: 0.5,
  })
  amountAdded: number;

  @ApiProperty({
    description: 'Novo saldo do usuário após a venda',
    example: 25.75,
  })
  newBalance: number;

  @ApiProperty({
    description: 'Item vendido',
    type: () => UserItemDto,
  })
  soldItem: UserItemDto;
}

export class updateConfigUserDto {
  @ApiPropertyOptional({
    description: 'Endereço da carteira Solana (44 caracteres base58)',
    example: '7xKXtg2CW99iVRBZ1W2Gz9n7dHf8GzQGjzJ8LwWJGzQ',
    required: false,
  })
  @IsOptional()
  walletAddress: string;

  @ApiPropertyOptional({
    description: 'username',
    example: 'example',
    required: false,
  })
  @IsOptional()
  username?: string;

  @ApiPropertyOptional({
    description: 'email',
    example: 'example@example.com',
    required: false,
  })
  @IsOptional()
  @IsEmail({}, { message: 'Email inválido' })
  email?: string;
}

export class SellItemResponseDto {
  @ApiProperty({
    description: 'Mensagem de sucesso',
    example: 'Item vendido com sucesso',
  })
  message: string;

  @ApiProperty({ description: 'Dados da venda' })
  data: SellItemDataDto;
}
