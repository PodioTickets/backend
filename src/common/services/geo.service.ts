import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { GeoStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { GeoGateway } from '../gateways/geo.gateway';

/**
 * Cache GLOBAL de geocoding (bairro/cidade/UF → lat/lng), compartilhado entre
 * todos os organizadores. Cada local é geocodificado UMA vez pelo Nominatim (OSM)
 * por um worker com throttle (respeita ≤1 req/s da política). O dashboard chama
 * `resolveMany`, que enfileira locais novos (PENDING) e devolve as coordenadas já
 * resolvidas; os PENDING viram RESOLVED/NOT_FOUND ao longo do tempo (aparecem na
 * carga seguinte). Assim o FRONT não geocodifica nada — só plota, instantâneo.
 */

export interface GeoInput {
  neighborhood?: string | null;
  city: string;
  state?: string | null;
}

const MAX_ATTEMPTS = 3;
const WORKER_INTERVAL_MS = 1500;
const FALLBACK_DELAY_MS = 1100;
// Nominatim exige um User-Agent identificável (server-side pode setar).
const NOMINATIM_UA = 'PodioTicket-dashboard/1.0 (contato: lgpd@podioticket.com.br)';

function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function keyOf(loc: GeoInput): string {
  const n = loc.neighborhood?.trim() ? normalize(loc.neighborhood) : '';
  const c = normalize(loc.city);
  const s = loc.state?.trim() ? normalize(loc.state) : '';
  return `${n}|${c}|${s}`;
}

function queryOf(neighborhood: string | null, city: string, state: string | null): string {
  return [neighborhood, city, state, 'Brasil'].filter(Boolean).join(', ');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);
  private processing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: GeoGateway,
  ) {}

  /**
   * Enfileira os locais novos (PENDING) e devolve, alinhado à ordem de entrada:
   * `coord` (null enquanto pendente/não-encontrado) e `pending` (true só enquanto
   * ainda vai ser geocodificado — NOT_FOUND conta como `false`, para o front parar
   * de fazer polling em locais que nunca resolvem).
   */
  async resolveMany(
    locs: GeoInput[],
  ): Promise<Array<{ coord: { lat: number; lng: number } | null; pending: boolean }>> {
    if (locs.length === 0) return [];
    const keys = locs.map(keyOf);
    const uniqueKeys = Array.from(new Set(keys));

    const existing = await this.prisma.getReadClient().geoCache.findMany({
      where: { key: { in: uniqueKeys } },
      select: { key: true, lat: true, lng: true, status: true },
    });
    const byKey = new Map(existing.map((e) => [e.key, e]));

    // Insere PENDING os locais que ainda não existem (dedup por key no lote).
    const seen = new Set<string>();
    const toCreate: Array<{
      key: string;
      neighborhood: string | null;
      city: string;
      state: string | null;
    }> = [];
    for (let i = 0; i < locs.length; i++) {
      const key = keys[i];
      if (byKey.has(key) || seen.has(key)) continue;
      seen.add(key);
      toCreate.push({
        key,
        neighborhood: locs[i].neighborhood?.trim() || null,
        city: locs[i].city,
        state: locs[i].state?.trim() || null,
      });
    }
    if (toCreate.length > 0) {
      await this.prisma
        .getWriteClient()
        .geoCache.createMany({ data: toCreate, skipDuplicates: true });
    }

    return keys.map((key) => {
      const e = byKey.get(key);
      if (e && e.status === GeoStatus.RESOLVED && e.lat != null && e.lng != null) {
        return { coord: { lat: e.lat, lng: e.lng }, pending: false };
      }
      // NOT_FOUND (desistiu) → não é pendente; PENDING ou recém-enfileirado → pendente.
      const pending = !e || e.status === GeoStatus.PENDING;
      return { coord: null, pending };
    });
  }

  /**
   * Worker: geocodifica UM local PENDING por tick (com fallback bairro→cidade).
   * O guard `processing` evita sobreposição de ticks. ~1 req/s efetivo.
   */
  @Interval(WORKER_INTERVAL_MS)
  async processPending(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const entry = await this.prisma.getReadClient().geoCache.findFirst({
        where: { status: GeoStatus.PENDING, attempts: { lt: MAX_ATTEMPTS } },
        orderBy: { createdAt: 'asc' },
      });
      if (!entry) return;

      const coord = await this.geocode(entry.neighborhood, entry.city, entry.state);
      if (coord) {
        await this.prisma.getWriteClient().geoCache.update({
          where: { id: entry.id },
          data: { lat: coord.lat, lng: coord.lng, status: GeoStatus.RESOLVED },
        });
        // Notifica os dashboards abertos (mapa preenche em tempo real, sem polling).
        this.gateway.emitGeoResolved();
      } else {
        const attempts = entry.attempts + 1;
        await this.prisma.getWriteClient().geoCache.update({
          where: { id: entry.id },
          data: {
            attempts,
            status: attempts >= MAX_ATTEMPTS ? GeoStatus.NOT_FOUND : GeoStatus.PENDING,
          },
        });
      }
    } catch (e) {
      this.logger.warn(`Geocoding worker falhou: ${(e as Error)?.message}`);
    } finally {
      this.processing = false;
    }
  }

  /** Tenta "bairro, cidade, UF"; se falhar (bairro inexistente), cai pra "cidade, UF". */
  private async geocode(
    neighborhood: string | null,
    city: string,
    state: string | null,
  ): Promise<{ lat: number; lng: number } | null> {
    const primary = await this.nominatim(queryOf(neighborhood, city, state));
    if (primary) return primary;
    if (neighborhood) {
      await sleep(FALLBACK_DELAY_MS); // respeita ≤1 req/s
      return this.nominatim(queryOf(null, city, state));
    }
    return null;
  }

  private async nominatim(q: string): Promise<{ lat: number; lng: number } | null> {
    const url =
      'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&q=' +
      encodeURIComponent(q);
    const res = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_UA, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ lat: string; lon: string }>;
    const first = data?.[0];
    if (!first) return null;
    const lat = Number(first.lat);
    const lng = Number(first.lon);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
}
