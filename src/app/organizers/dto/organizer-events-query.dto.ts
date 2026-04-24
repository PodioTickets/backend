import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { EventStatus } from '@prisma/client';

/** Query params para GET /organizers/me/events — objeto plano para o ValidationPipe global. */
export class OrganizerEventsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;

  /** Query string: omitir ou `true`/`false` (compatível com `includePast !== 'false'`). */
  @IsOptional()
  @IsString()
  includePast?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  name?: string;
}
