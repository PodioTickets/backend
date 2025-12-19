import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  Min,
  IsUrl,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
  @ApiPropertyOptional({
    description: 'Whether the event topic is enabled',
    example: true,
  })
  isEnabled?: boolean;

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
  @ApiPropertyOptional({
    description: 'Whether the event topic is enabled',
    example: true,
  })
  isEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({
    description: 'The order of the event topic',
    example: 0,
  })
  order?: number;
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

