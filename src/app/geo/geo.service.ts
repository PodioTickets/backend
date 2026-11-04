import { BadRequestException, Injectable } from '@nestjs/common';
import { City, Country, State } from 'country-state-city';
import * as geoip from 'geoip-lite';
import { isIP } from 'net';
import { ListCitiesDto } from './dto/list-cities.dto';

/** Teto default de cidades quando o cliente não envia `limit` (ver contrato). */
const DEFAULT_CITIES_LIMIT = 1000;

type IpLocation = {
  lat: number;
  lng: number;
  city: string | null;
  region: string | null;
  country: string | null;
};

/**
 * Normaliza para comparação case/acento-insensível.
 * NFD separa os diacríticos; o range ̀-ͯ remove-os (mesma técnica usada
 * na normalização de cidades do dashboard).
 */
function normalizeForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Valida e normaliza o country code para ISO 3166-1 alpha-2 maiúsculo.
 * País fora do padrão / inexistente → 400 (o frontend cai em texto livre).
 */
function resolveCountryCode(raw: string): string {
  const code = (raw ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || !Country.getCountryByCode(code)) {
    throw new BadRequestException(
      'Código de país inválido. Use ISO 3166-1 alpha-2 (ex.: US, AR, PT).',
    );
  }
  return code;
}

/**
 * Geo: dado de referência ESTÁTICO e PÚBLICO (estados/cidades por país) servido a
 * partir do dataset `country-state-city`. Sem banco, sem rede, sem autenticação.
 * Cobre apenas o fluxo estrangeiro do checkout; o Brasil segue com UF fixa + ViaCEP.
 */
@Injectable()
export class GeoService {
  /**
   * Estados/províncias de um país (ISO 3166-1 alpha-2).
   * `code` = parte de subdivisão do ISO 3166-2 (`isoCode`), tratado como opaco pelo
   * frontend. País sem subdivisões → `states: []` (frontend cai em texto livre).
   */
  getStates(countryCodeRaw: string) {
    const countryCode = resolveCountryCode(countryCodeRaw);

    const states = State.getStatesOfCountry(countryCode)
      .map((s) => ({ code: s.isoCode, name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { success: true, data: { states } };
  }

  /**
   * Cidades de um estado/província. `stateCode` é o `code` retornado por getStates.
   * Filtro `search` (case/acento-insensível) e teto `limit` opcionais. Nomes
   * duplicados são deduplicados (indistinguíveis no dropdown). Estado sem cidades
   * catalogadas → `cities: []`.
   */
  getCities(countryCodeRaw: string, stateCode: string, query: ListCitiesDto) {
    const countryCode = resolveCountryCode(countryCodeRaw);
    const code = (stateCode ?? '').trim();

    const search = query.search ? normalizeForSearch(query.search) : '';
    const limit = query.limit ?? DEFAULT_CITIES_LIMIT;

    const seen = new Set<string>();
    const cities: Array<{ name: string }> = [];
    for (const city of City.getCitiesOfState(countryCode, code)) {
      const name = city.name;
      if (search && !normalizeForSearch(name).includes(search)) continue;
      if (seen.has(name)) continue; // dedup de nomes idênticos (mesmo valor persistido)
      seen.add(name);
      cities.push({ name });
    }

    cities.sort((a, b) => a.name.localeCompare(b.name));

    return {
      success: true,
      data: { cities: cities.length > limit ? cities.slice(0, limit) : cities },
    };
  }

  /**
   * Geolocalização APROXIMADA (nível cidade) a partir do IP do cliente, via IPinfo.
   * O `geoip-lite` (base embarcada, sem rede) só cobre falha do IPinfo ou falta de token:
   * sozinho ele não tem cidade para boa parte dos IPs de operadora, sobretudo IPv6.
   * Usada para CENTRALIZAR o mapa de seleção de local ao CRIAR um evento (nunca fixa o
   * pino) e no texto "Perto de <cidade>" do card de busca mobile.
   *
   * Retorna `location: null` (sem erro) quando o IP é privado/loopback (dev),
   * IPv6-mapeado sem match, ou não resolvível — o frontend cai no comportamento
   * atual (centro do Brasil). Resiliência intencional: não é dado crítico.
   */
  async getIpLocation(ip: string): Promise<{ success: boolean; data: { location: IpLocation | null } }> {
    // `::ffff:1.2.3.4` (IPv4 mapeado em IPv6) → normaliza igual ao auth.service.
    let cleanIp = (ip ?? '').replace(/^::ffff:/, '').trim();
    // DEV: IP local/privado (localhost, rede de casa) nunca tem cidade. `GEOIP_DEV_IP` (ex.: um IP
    // público de Curitiba) permite testar a tela; ignorado em produção e para IP público.
    const isLocalIp = !cleanIp || /^(::1$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(cleanIp);
    if (isLocalIp && process.env.NODE_ENV !== 'production' && process.env.GEOIP_DEV_IP) {
      cleanIp = process.env.GEOIP_DEV_IP.trim();
    }
    if (!cleanIp) return { success: true, data: { location: null } };

    const ipinfo = await this.lookupIpinfo(cleanIp);
    if (ipinfo) return { success: true, data: { location: ipinfo } };

    try {
      const geo = geoip.lookup(cleanIp);
      const ll = geo?.ll;
      if (Array.isArray(ll) && ll.length === 2) {
        const [lat, lng] = ll;
        if (
          typeof lat === 'number' &&
          typeof lng === 'number' &&
          Number.isFinite(lat) &&
          Number.isFinite(lng)
        ) {
          return {
            success: true,
            data: {
              location: {
                lat,
                lng,
                city: geo?.city || null,
                region: geo?.region || null,
                country: geo?.country || null,
              },
            },
          };
        }
      }
    } catch {
      // base indisponível / IP inválido → trata como "sem localização".
    }

    return { success: true, data: { location: null } };
  }

  /** Fonte principal (mesmo token do e-mail de segurança). Falha → null: cai no `geoip-lite`. */
  private async lookupIpinfo(ip: string): Promise<IpLocation | null> {
    const token = process.env.IPINFO_TOKEN;
    // `ip` vem do X-Forwarded-For (forjável): só IP válido entra na URL que carrega o token.
    if (!token || !isIP(ip)) return null;

    try {
      const res = await fetch(`https://ipinfo.io/${ip}/json?token=${token}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      const d = await res.json();
      const [lat, lng] = String(d?.loc ?? '').split(',').map(Number);
      if (d?.bogon || !d?.city || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

      // IPinfo manda o NOME do estado; o card mostra a UF, como o geoip-lite.
      const regionName = d.region === 'Federal District' ? 'Distrito Federal' : d.region;
      const state = State.getStatesOfCountry(d.country).find(
        (s) => normalizeForSearch(s.name) === normalizeForSearch(regionName ?? ''),
      );
      return {
        lat,
        lng,
        city: d.city,
        region: state?.isoCode ?? d.region ?? null,
        country: d.country ?? null,
      };
    } catch {
      return null;
    }
  }
}
