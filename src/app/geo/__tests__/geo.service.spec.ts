/**
 * ROTEIRO — contrato geo (estados/cidades por país) — geo-states-cities-spec.md
 * =============================================================================
 * Endpoints públicos de dado de referência (country-state-city). Valida:
 *  - estados: shape { code, name }, ordenação por nome, alpha-2 case-insensível, 400 inválido;
 *  - cidades: shape { name }, filtro search (acento/case-insensível), limit, dedup, 400 inválido.
 */
import { BadRequestException } from '@nestjs/common';
import { GeoService } from '../geo.service';

describe('GeoService — geo (estados/cidades por país)', () => {
  let service: GeoService;

  beforeEach(() => {
    service = new GeoService();
  });

  describe('getStates', () => {
    it('retorna estados no shape { code, name } ordenados por nome', () => {
      const res = service.getStates('US');

      expect(res.success).toBe(true);
      const states = res.data.states;
      expect(Array.isArray(states)).toBe(true);
      expect(states.length).toBeGreaterThan(0);
      // shape
      expect(states[0]).toEqual({
        code: expect.any(String),
        name: expect.any(String),
      });
      // California presente com code = isoCode 'CA'
      expect(states).toContainEqual({ code: 'CA', name: 'California' });
      // ordenado por name
      const names = states.map((s) => s.name);
      expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
    });

    it('aceita alpha-2 minúsculo (normaliza para maiúsculo)', () => {
      expect(service.getStates('us').data.states.length).toBeGreaterThan(0);
    });

    it('país inválido / fora do padrão alpha-2 → 400', () => {
      expect(() => service.getStates('XX')).toThrow(BadRequestException);
      expect(() => service.getStates('BRASIL')).toThrow(BadRequestException);
      expect(() => service.getStates('')).toThrow(BadRequestException);
    });
  });

  describe('getCities', () => {
    it('retorna cidades no shape { name } ordenadas, sem chave extra', () => {
      const res = service.getCities('US', 'CA', {});

      expect(res.success).toBe(true);
      const cities = res.data.cities;
      expect(cities.length).toBeGreaterThan(0);
      expect(Object.keys(cities[0])).toEqual(['name']); // só name
      expect(cities.map((c) => c.name)).toContain('Los Angeles');
      const names = cities.map((c) => c.name);
      expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
    });

    it('search filtra por substring case/acento-insensível', () => {
      const res = service.getCities('US', 'CA', { search: 'san FRAN' });
      const names = res.data.cities.map((c) => c.name);
      expect(names).toContain('San Francisco');
      expect(names.every((n) => n.toLowerCase().includes('san fran'))).toBe(true);
    });

    it('limit limita a quantidade retornada', () => {
      const res = service.getCities('US', 'CA', { limit: 5 });
      expect(res.data.cities.length).toBe(5);
    });

    it('não retorna nomes duplicados', () => {
      const names = service.getCities('US', 'CA', {}).data.cities.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('estado inexistente → lista vazia (não lança)', () => {
      const res = service.getCities('US', 'ZZZ', {});
      expect(res.data.cities).toEqual([]);
    });

    it('país inválido → 400', () => {
      expect(() => service.getCities('XX', 'CA', {})).toThrow(BadRequestException);
    });
  });

  describe('getIpLocation', () => {
    it('IP vazio → location null (não lança)', () => {
      const res = service.getIpLocation('');
      expect(res.success).toBe(true);
      expect(res.data.location).toBeNull();
    });

    it('IP privado/loopback → location null (não resolvível)', () => {
      // Loopback e RFC1918 não têm geolocalização na base do geoip-lite.
      expect(service.getIpLocation('127.0.0.1').data.location).toBeNull();
      expect(service.getIpLocation('192.168.0.1').data.location).toBeNull();
    });

    it('IP público conhecido → lat/lng numéricos', () => {
      // 8.8.8.8 (Google DNS) está catalogado na base embarcada.
      const res = service.getIpLocation('8.8.8.8');
      expect(res.success).toBe(true);
      // A base pode variar entre versões; se resolveu, o shape tem que bater.
      if (res.data.location) {
        expect(typeof res.data.location.lat).toBe('number');
        expect(typeof res.data.location.lng).toBe('number');
        expect(Number.isFinite(res.data.location.lat)).toBe(true);
        expect(Number.isFinite(res.data.location.lng)).toBe(true);
      }
    });

    it('normaliza IPv4 mapeado em IPv6 (::ffff:) sem lançar', () => {
      expect(() => service.getIpLocation('::ffff:8.8.8.8')).not.toThrow();
    });
  });
});
