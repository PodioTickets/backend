import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const KIT_IMAGES_LAYOUT_VALUES = ['ON_TICKETS', 'ON_CATEGORIES'] as const;
export type KitImagesLayout = (typeof KIT_IMAGES_LAYOUT_VALUES)[number];

/** Chave literal para ingressos sem categoria (alinhado ao frontend). */
export const UNCATEGORIZED_CATEGORY_KEY = 'uncategorized';

export class EventKitSelectionDisplayDto {
  @IsBoolean()
  @ApiProperty()
  showKitImagesOnSelection: boolean;

  @IsIn(KIT_IMAGES_LAYOUT_VALUES)
  @ApiProperty({ enum: KIT_IMAGES_LAYOUT_VALUES })
  kitImagesLayout: KitImagesLayout;

  @IsObject()
  @ApiProperty({
    description: 'ticketId → imageUrl (URL da imagem primária do kit para esse ingresso)',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  primaryKitProductByTicketId: Record<string, string>;

  @IsObject()
  @ApiProperty({
    description: 'categoryId ou "uncategorized" → imageUrl (URL da imagem primária do kit para essa categoria)',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  primaryKitProductByCategoryId: Record<string, string>;

  @IsOptional()
  @IsObject()
  @ApiPropertyOptional({
    description:
      'ticketId → lista de URLs de imagens OCULTAS na tela de escolha desse ingresso',
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
  })
  hiddenKitImageUrlsByTicketId?: Record<string, string[]>;

  @IsOptional()
  @IsObject()
  @ApiPropertyOptional({
    description:
      'categoryId ou "uncategorized" → lista de URLs de imagens OCULTAS nessa categoria',
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
  })
  hiddenKitImageUrlsByCategoryId?: Record<string, string[]>;
}
