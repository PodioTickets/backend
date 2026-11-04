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
    it('IP vazio → location null (não lança)', async () => {
      const res = await service.getIpLocation('');
      expect(res.success).toBe(true);
      expect(res.data.location).toBeNull();
    });

    it('IP privado/loopback → location null (não resolvível)', async () => {
      // Loopback e RFC1918 não têm geolocalização na base do geoip-lite.
      expect((await service.getIpLocation('127.0.0.1')).data.location).toBeNull();
      expect((await service.getIpLocation('192.168.0.1')).data.location).toBeNull();
    });

    it('IP público conhecido → lat/lng numéricos', async () => {
      // 8.8.8.8 (Google DNS) está catalogado na base embarcada.
      const res = await service.getIpLocation('8.8.8.8');
      expect(res.success).toBe(true);
      // A base pode variar entre versões; se resolveu, o shape tem que bater.
      if (res.data.location) {
        expect(typeof res.data.location.lat).toBe('number');
        expect(typeof res.data.location.lng).toBe('number');
        expect(Number.isFinite(res.data.location.lat)).toBe(true);
        expect(Number.isFinite(res.data.location.lng)).toBe(true);
      }
    });

    it('normaliza IPv4 mapeado em IPv6 (::ffff:) sem lançar', async () => {
      await expect(service.getIpLocation('::ffff:8.8.8.8')).resolves.toBeDefined();
    });

    describe('IPinfo como fonte principal', () => {
      // Sem cidade no geoip-lite — ver medição de 04/11.
      const NO_CITY_IP = '187.26.40.2';
      // Curitiba no geoip-lite.
      const WITH_CITY_IP = '177.92.0.1';
      const fetchMock = jest.fn();
      const ipinfo = (body: unknown, ok = true) => ({ ok, json: async () => body });

      beforeEach(() => {
        process.env.IPINFO_TOKEN = 'token-teste';
        fetchMock.mockReset();
        global.fetch = fetchMock as unknown as typeof fetch;
      });
      afterEach(() => {
        delete process.env.IPINFO_TOKEN;
      });

      it('usa a cidade do IPinfo e converte o nome do estado em UF', async () => {
        fetchMock.mockResolvedValue(
          ipinfo({ city: 'São Paulo', region: 'São Paulo', country: 'BR', loc: '-23.5475,-46.6361' }),
        );
        const { location } = (await service.getIpLocation(NO_CITY_IP)).data;
        expect(location).toEqual({
          lat: -23.5475,
          lng: -46.6361,
          city: 'São Paulo',
          region: 'SP',
          country: 'BR',
        });
      });

      it('resolve IPv6 e o Distrito Federal ("Federal District")', async () => {
        fetchMock.mockResolvedValue(
          ipinfo({ city: 'Brasília', region: 'Federal District', country: 'BR', loc: '-15.7,-47.9' }),
        );
        const { location } = (await service.getIpLocation('2804:214:8000::1')).data;
        expect(location?.region).toBe('DF');
      });

      it('prefere o IPinfo mesmo quando a base local tem a cidade', async () => {
        fetchMock.mockResolvedValue(
          ipinfo({ city: 'Londrina', region: 'Paraná', country: 'BR', loc: '-23.3,-51.1' }),
        );
        const { location } = (await service.getIpLocation(WITH_CITY_IP)).data;
        expect(location?.city).toBe('Londrina');
        expect(location?.region).toBe('PR');
      });

      it('sem token não chama o IPinfo e usa a base local', async () => {
        delete process.env.IPINFO_TOKEN;
        const { location } = (await service.getIpLocation(WITH_CITY_IP)).data;
        expect(fetchMock).not.toHaveBeenCalled();
        expect(location?.city).toBe('Curitiba');
      });

      it('IPinfo fora do ar → usa a cidade da base local', async () => {
        fetchMock.mockRejectedValue(new Error('timeout'));
        const { location } = (await service.getIpLocation(WITH_CITY_IP)).data;
        expect(location?.city).toBe('Curitiba');
      });

      it('IP forjado no X-Forwarded-For não entra na URL com o token', async () => {
        await service.getIpLocation('8.8.8.8/../../outra-rota?x=');
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it.each([
        ['erro de rede', () => fetchMock.mockRejectedValue(new Error('timeout'))],
        ['resposta não-ok', () => fetchMock.mockResolvedValue(ipinfo({}, false))],
        ['bogon', () => fetchMock.mockResolvedValue(ipinfo({ bogon: true }))],
      ])('%s → mantém o resultado local, sem lançar', async (_nome, arrange) => {
        arrange();
        const { location } = (await service.getIpLocation(NO_CITY_IP)).data;
        expect(location?.country).toBe('BR');
        expect(location?.city).toBeNull();
      });
    });
  });
});
