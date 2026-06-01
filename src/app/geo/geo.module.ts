import { Module } from '@nestjs/common';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';

/**
 * Endpoints públicos de geo (estados/cidades por país) servidos de dataset estático.
 * Sem dependências (sem Prisma): os dados vêm do pacote `country-state-city`.
 */
@Module({
  controllers: [GeoController],
  providers: [GeoService],
})
export class GeoModule {}
