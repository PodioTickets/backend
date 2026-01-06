import {
  IsString,
  IsOptional,
  IsDateString,
  IsEnum,
  IsBoolean,
  IsInt,
  Min,
  Max,
  IsUrl,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EventStatus } from '@prisma/client';

export class CreateEventDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  bannerUrl?: string;

  @IsString()
  location: string;

  @IsString()
  city: string;

  @IsString()
  state: string;

  @IsString()
  country: string;

  @IsOptional()
  googleMapsLink?: string;

  @IsDateString()
  eventDate: string;

  @IsDateString()
  registrationStartDate: string;

  @IsDateString()
  registrationEndDate: string;
}

export class UpdateEventDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  bannerUrl?: string;

  @IsOptional()
  @IsString()
  location?: string;

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
  googleMapsLink?: string;

  @IsOptional()
  @IsDateString()
  eventDate?: string;

  @IsOptional()
  @IsDateString()
  registrationStartDate?: string;

  @IsOptional()
  @IsDateString()
  registrationEndDate?: string;

  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;
}

export class FilterEventsDto {
  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsBoolean()
  thisWeek?: boolean;

  @IsOptional()
  @IsBoolean()
  thisMonth?: boolean;

  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  includePast?: boolean;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  includeDraft?: boolean; // Para organizadores verem seus próprios eventos DRAFT

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number = 10;
}

export class SearchEventsDto {
  @IsOptional()
  @IsString()
  q?: string; // Query de busca livre (busca em nome, descrição, localização)

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  includePast?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 20;
}