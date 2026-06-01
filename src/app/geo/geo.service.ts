import { BadRequestException, Injectable } from '@nestjs/common';
import { City, Country, State } from 'country-state-city';
import { ListCitiesDto } from './dto/list-cities.dto';

/** Teto default de cidades quando o cliente não envia `limit` (ver contrato). */
const DEFAULT_CITIES_LIMIT = 1000;

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
}
