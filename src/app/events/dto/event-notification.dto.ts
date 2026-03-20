import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ArrayMinSize,
} from 'class-validator';

/** Valores estáveis do status (espelham `EventNotificationStatus` no Prisma). */
export const EVENT_NOTIFICATION_STATUS_VALUES = ['review', 'sent', 'denied'] as const;

/** Canais aceitos na API (strings estáveis para o frontend). */
export const EVENT_NOTIFICATION_CHANNEL_VALUES = ['email', 'whatsapp', 'push'] as const;
export type EventNotificationChannelValue = (typeof EVENT_NOTIFICATION_CHANNEL_VALUES)[number];

export class ListEventNotificationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsIn(EVENT_NOTIFICATION_STATUS_VALUES)
  status?: (typeof EVENT_NOTIFICATION_STATUS_VALUES)[number];
}

export class CreateEventNotificationDto {
  @IsString()
  @MaxLength(200)
  title: string;

  @IsString()
  @MaxLength(102400)
  messageHtml: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  channels: string[];
}
