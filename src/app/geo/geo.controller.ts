import { Controller, Get, Header, Param, Query, Req } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { GeoService } from './geo.service';
import { ListCitiesDto } from './dto/list-cities.dto';
import { getClientIp } from '../../common/utils/client-ip.util';

/**
 * Geo é dado de referência imutável e público → cache agressivo de CDN/browser.
 * Exceção intencional à política global `no-store` (o frontend também sobrescreve
 * a política "menos cache" para estas queries). Ver geo-states-cities-spec.md.
 */
const GEO_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';

@ApiTags('Geo')
@Controller('api/v1/geo')
export class GeoController {
  constructor(private readonly geoService: GeoService) {}

  @Get('countries/:countryCode/states')
  @Header('Cache-Control', GEO_CACHE_CONTROL)
  @ApiOperation({ summary: 'Estados/províncias de um país (ISO 3166-1 alpha-2)' })
  @ApiParam({ name: 'countryCode', example: 'US', description: 'ISO 3166-1 alpha-2 (maiúsculo)' })
  @ApiResponse({ status: 200, description: 'Lista de estados (pode ser vazia)' })
  @ApiResponse({ status: 400, description: 'Código de país inválido' })
  getStates(@Param('countryCode') countryCode: string) {
    return this.geoService.getStates(countryCode);
  }

  @Get('countries/:countryCode/states/:stateCode/cities')
  @Header('Cache-Control', GEO_CACHE_CONTROL)
  @ApiOperation({ summary: 'Cidades de um estado/província' })
  @ApiParam({ name: 'countryCode', example: 'US', description: 'ISO 3166-1 alpha-2 (maiúsculo)' })
  @ApiParam({ name: 'stateCode', example: 'CA', description: 'code retornado pelo endpoint de estados' })
  @ApiQuery({ name: 'search', required: false, description: 'Filtro por nome (case/acento-insensível)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Teto de itens (default 1000)' })
  @ApiResponse({ status: 200, description: 'Lista de cidades (pode ser vazia)' })
  @ApiResponse({ status: 400, description: 'Código de país inválido' })
  getCities(
    @Param('countryCode') countryCode: string,
    @Param('stateCode') stateCode: string,
    @Query() query: ListCitiesDto,
  ) {
    return this.geoService.getCities(countryCode, stateCode, query);
  }

  /**
   * Localização aproximada (cidade) pelo IP do cliente — só para centralizar o mapa
   * ao criar um evento. Resposta VARIA por IP → NUNCA cacheável em CDN compartilhada
   * (`private, no-store`), ao contrário dos estados/cidades (dado estático).
   */
  @Get('ip-location')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Localização aproximada (cidade) pelo IP do cliente' })
  @ApiResponse({
    status: 200,
    description: 'Localização por IP; `location: null` quando não resolvível',
  })
  getIpLocation(@Req() req: ExpressRequest) {
    return this.geoService.getIpLocation(getClientIp(req));
  }
}
