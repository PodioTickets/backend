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
    description: 'ticketId → productId (produto deve estar vinculado ao ingresso)',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  primaryKitProductByTicketId: Record<string, string>;

  @IsObject()
  @ApiProperty({
    description: 'categoryId ou "uncategorized" → productId',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  primaryKitProductByCategoryId: Record<string, string>;
}
