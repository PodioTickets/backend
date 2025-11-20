import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  Min,
  IsDateString,
  IsUrl,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateEventTopicDto {
  @IsString()
  title: string;

  @IsString()
  content: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}

export class UpdateEventTopicDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}

export class CreateEventLocationDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsString()
  address: string;

  @IsString()
  city: string;

  @IsString()
  state: string;

  @IsString()
  country: string;

  @IsOptional()
  @IsString()
  zipCode?: string;

  @IsOptional()
  @IsUrl()
  googleMapsLink?: string;

  @IsOptional()
  latitude?: number;

  @IsOptional()
  longitude?: number;
}

export class UpdateEventLocationDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  zipCode?: string;

  @IsOptional()
  @IsUrl()
  googleMapsLink?: string;

  @IsOptional()
  latitude?: number;

  @IsOptional()
  longitude?: number;
}

