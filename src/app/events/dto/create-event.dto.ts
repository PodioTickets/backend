import {
  IsString,
  IsOptional,
  IsDateString,
  IsEnum,
  IsBoolean,
  IsInt,
  IsNumber,
  IsIn,
  Min,
  Max,
  IsUrl,
  IsEmail,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EventStatus } from '@prisma/client';
import { EventKitSelectionDisplayDto } from './kit-selection-display.dto';

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
  @IsString()
  bannerUrl?: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;

  /** Alias do painel para `logoUrl` (imagem do card / marca do evento). */
  @IsOptional()
  @IsString()
  cardImageUrl?: string;

  @IsString()
  location: string;

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
  @IsString()
  neighborhood?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true }, { message: 'googleMapsLink must be a valid URL' })
  googleMapsLink?: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  instagram?: string;

  @IsOptional()
  @IsString()
  facebook?: string;

  @IsOptional()
  @IsString()
  youtube?: string;

  @IsOptional()
  @IsString()
  tiktok?: string;

  @IsOptional()
  @IsString()
  website?: string;

  @IsOptional()
  @IsString()
  regulationUrl?: string;

  @IsDateString()
  eventDate: string;

  @IsDateString()
  registrationStartDate: string;

  @IsDateString()
  registrationEndDate: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(6)
  organizerFeePercent?: number;

  @IsOptional()
  @IsInt()
  @IsIn([1, 2, 3])
  maxInstallments?: number;
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
  @IsString()
  bannerUrl?: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;

  /** Alias do painel para `logoUrl` (imagem do card / marca do evento). */
  @IsOptional()
  @IsString()
  cardImageUrl?: string;

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
  @IsString()
  zipCode?: string;

  @IsOptional()
  @IsString()
  neighborhood?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true }, { message: 'googleMapsLink must be a valid URL' })
  googleMapsLink?: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  instagram?: string;

  @IsOptional()
  @IsString()
  facebook?: string;

  @IsOptional()
  @IsString()
  youtube?: string;

  @IsOptional()
  @IsString()
  tiktok?: string;

  @IsOptional()
  @IsString()
  website?: string;

  @IsOptional()
  @IsString()
  regulationUrl?: string;

  @IsOptional()
  @IsDateString()
  eventDate?: string;

  @IsOptional()
  @IsDateString()
  registrationStartDate?: string;

  @IsOptional()
  @IsDateString()
  registrationEndDate?: string;

  /** Rota/página do painel (opcional) para o audit log, ex.: `event-edit`, `events/abc/general` */
  @IsOptional()
  @IsString()
  clientPage?: string;

  /** Exibição de imagens do kit na escolha de ingressos. `null` remove a configuração (cliente usa defaults). */
  @ApiPropertyOptional({ type: EventKitSelectionDisplayDto, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @ValidateNested()
  @Type(() => EventKitSelectionDisplayDto)
  kitSelectionDisplay?: EventKitSelectionDisplayDto | null;
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

  /**
   * Quando true (default), inclui `hasRegistrationSlotsAvailable` em cada evento (custo: 2 queries agregadas na página).
   * Use false para listagens que não precisam do indicador de vaga.
   */
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  includeHasSlots?: boolean;

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

  @IsOptional()
  @IsString()
  modalities?: string; // CSV de códigos de modalidade (ex: "corrida,natacao")

  /** Piso do FILTRO de preço, em REAIS (slider 0–1000). O evento entra quando
   *  possui ALGUM ingresso ativo com preço dentro de [minPrice, maxPrice];
   *  some quando nenhum ingresso cai no intervalo. Lotes futuros (ainda não à
   *  venda) não contam. Convertido p/ centavos no service. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  minPrice?: number;

  /** Teto do FILTRO de preço, em REAIS (slider 0–1000). Ver `minPrice`. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  maxPrice?: number;
}

/** Mesmos filtros opcionais de {@link SearchEventsDto}, exceto paginação e filtro por estado/cidade (facetas cobrem todos os pares). */
export class SearchEventLocationsDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  country?: string;

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

  /** Piso do filtro de preço em REAIS — ver {@link SearchEventsDto.minPrice}.
   *  Mantido nas facetas p/ que cidades/estados reflitam o mesmo recorte. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  minPrice?: number;

  /** Teto do filtro de preço em REAIS — ver {@link SearchEventsDto.maxPrice}. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  maxPrice?: number;
}