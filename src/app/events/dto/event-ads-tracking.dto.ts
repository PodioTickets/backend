import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';

function trimOptional(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value).trim();
}

/** Body parcial para PATCH .../tracking — omitir campo = não alterar. */
export class UpdateEventAdsTrackingDto {
  @ApiPropertyOptional({
    description: 'Meta Pixel ID (apenas dígitos, típ. 15–16). Vazio limpa.',
    example: '123456789012345',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => trimOptional(value))
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @Matches(/^\d{10,20}$/, {
    message: 'metaPixelId must be 10–20 digits only',
  })
  metaPixelId?: string;

  @ApiPropertyOptional({
    description: 'GA4 Measurement ID (G-...). Vazio limpa.',
    example: 'G-ABC123DEF4',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => trimOptional(value))
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @Matches(/^G-[A-Z0-9]+$/i, {
    message: 'googleAnalyticsId must be a GA4 ID (G- followed by alphanumeric)',
  })
  googleAnalyticsId?: string;

  @ApiPropertyOptional({
    description: 'Google Ads conversion tag (AW-...). Vazio limpa.',
    example: 'AW-123456789',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => trimOptional(value))
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @Matches(/^AW-[A-Z0-9]+$/i, {
    message: 'googleAdsId must start with AW- followed by alphanumeric',
  })
  googleAdsId?: string;
}
