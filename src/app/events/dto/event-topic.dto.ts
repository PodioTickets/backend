import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  Min,
  IsUrl,
  IsArray,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateEventTopicDto {
  @IsString()
  @ApiProperty({
    description: 'The title of the event topic',
    example: 'Event Topic Title',
  })
  title: string;

  @IsString()
  @ApiProperty({
    description: 'The content of the event topic',
    example: 'Event Topic Content',
  })
  content: string;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  @ApiPropertyOptional({
    description: 'Whether the event topic is enabled',
    example: true,
  })
  isEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  @ApiPropertyOptional({
    description:
      'Tópico do sistema (ex.: descrição, regulamento). Não pode ser excluído, apenas desativado.',
    example: false,
  })
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  @ApiPropertyOptional({
    description: 'Marca o tópico como obrigatório no fluxo do organizador',
    example: false,
  })
  isRequired?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({
    description: 'The order of the event topic',
    example: 0,
  })
  order?: number;
}

export class UpdateEventTopicDto {
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'The title of the event topic',
    example: 'Event Topic Title',
  })
  title?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'The content of the event topic',
    example: 'Event Topic Content',
  })
  content?: string;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  @ApiPropertyOptional({
    description: 'Whether the event topic is enabled',
    example: true,
  })
  isEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  @ApiPropertyOptional({
    description: 'Tópico padrão do sistema (não excluível)',
    example: false,
  })
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  @ApiPropertyOptional({
    description: 'Obrigatório no fluxo do organizador',
    example: false,
  })
  isRequired?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({
    description: 'The order of the event topic',
    example: 0,
  })
  order?: number;
}

/** Lista ordenada de IDs: posição no array = novo `order` (0, 1, 2, …). */
export class ReorderEventTopicsDto {
  @IsArray()
  @IsUUID(undefined, { each: true })
  @ApiProperty({
    description:
      'UUIDs de todos os tópicos do evento, na ordem desejada (primeiro item = order 0)',
    type: [String],
    example: [
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    ],
  })
  topicIds: string[];
}

export class CreateEventLocationDto {
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'The name of the event location',
    example: 'Event Location Name',
  })
  name?: string;

  @IsString()
  @ApiProperty({
    description: 'The address of the event location',
    example: 'Event Location Address',
  })
  address: string;

  @IsString()
  @ApiProperty({
    description: 'The city of the event location',
    example: 'Event Location City',
  })
  city: string;

  @IsString()
  @ApiProperty({
    description: 'The state of the event location',
    example: 'Event Location State',
  })
  state: string;

  @IsString()
  @ApiProperty({
    description: 'The country of the event location',
    example: 'Event Location Country',
  })
  country: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'The zip code of the event location',
    example: 'Event Location Zip Code',
  })
  zipCode?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'The neighborhood of the event location',
    example: 'Centro',
  })
  neighborhood?: string;

  @IsOptional()
  @IsUrl()
  @ApiPropertyOptional({
    description: 'The Google Maps link of the event location',
    example: 'https://www.google.com/maps/place/Event+Location',
  })
  googleMapsLink?: string;

  @IsOptional()
  @ApiPropertyOptional({
    description: 'The latitude of the event location',
    example: 12.3456789,
  })
  latitude?: number;

  @IsOptional()
  @ApiPropertyOptional({
    description: 'The longitude of the event location',
    example: 12.3456789,
  })
  longitude?: number;
}

export class UpdateEventLocationDto {
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  name?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  address?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  city?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  state?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  country?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  zipCode?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  neighborhood?: string;

  @IsOptional()
  @IsUrl()
  @ApiPropertyOptional()
  googleMapsLink?: string;

  @IsOptional()
  @ApiPropertyOptional()
  latitude?: number;

  @IsOptional()
  @ApiPropertyOptional()
  longitude?: number;
}

