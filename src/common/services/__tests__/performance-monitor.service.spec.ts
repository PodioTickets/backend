/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: o "medidor de desempenho" do servidor. Ele anota, a cada requisição
 *           que chega, quanto tempo demorou e se deu erro, e depois consegue
 *           montar um resumo (relatório) com médias, contagens e as rotas mais
 *           lentas.
 *
 *  EM RESUMO:
 *    Toda vez que o site responde a um pedido, o medidor registra: qual rota,
 *    quanto tempo levou e se foi erro de servidor (status 500+). Com base nisso
 *    ele calcula coisas como: total de pedidos, taxa de erro, tempo médio, uma
 *    estimativa do "tempo dos 95% mais rápidos" (p95) e um ranking das rotas
 *    mais devagar. Esses números também podem ser guardados no Redis para
 *    sobreviver a um reinício — mas se o Redis estiver fora, o sistema NÃO
 *    quebra: ele simplesmente começa do zero (comportamento "fail-open").
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Registrar uma requisição soma corretamente nos totais e na rota.
 *    • Requisições com erro de servidor (500+) contam como erro; 4xx não conta.
 *    • Rotas com IDs/UUIDs no caminho são agrupadas (ex.: /users/123 vira /users/:id).
 *    • A própria rota de monitoramento de performance é ignorada (não se mede).
 *    • O resumo calcula média, taxa de erro e p95 corretamente.
 *    • Sem nenhuma amostra, o resumo devolve zeros (não quebra com divisão por zero).
 *    • O ranking de rotas lentas só mostra rotas com volume mínimo e ordena pela média.
 *    • Salvar no Redis só acontece quando há mudança e quando o Redis está disponível.
 *    • Carregar do Redis re-popula os contadores; se o formato for incompatível, ignora.
 *    • Se o Redis estiver fora, nada disso quebra o servidor (fail-open).
 *
 *  COMO CONFERIMOS:
 *    Criamos o medidor com um Redis "de mentira" (mock) e simulamos requisições
 *    entrando, depois conferimos os números do resumo e o que foi (ou não) salvo.
 * ============================================================================
 */
import { PerformanceMonitorService } from '../performance-monitor.service';
import type { CacheRedisService } from '../cache-redis.service';

type CacheMock = {
  getJson: jest.Mock;
  setJson: jest.Mock;
  isAvailable: jest.Mock;
};

function makeCache(overrides: Partial<CacheMock> = {}): CacheMock {
  return {
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(undefined),
    isAvailable: jest.fn().mockReturnValue(true),
    ...overrides,
  };
}

function makeService(cache: CacheMock) {
  // Cast para CacheRedisService: só usamos getJson/setJson/isAvailable.
  return new PerformanceMonitorService(cache as unknown as CacheRedisService);
}

// Atalho para registrar uma requisição com defaults razoáveis.
function rec(
  service: PerformanceMonitorService,
  over: Partial<{ method: string; path: string; statusCode: number; durationMs: number }> = {},
) {
  service.recordRequest({
    method: over.method ?? 'GET',
    path: over.path ?? '/api/v1/orders',
    statusCode: over.statusCode ?? 200,
    durationMs: over.durationMs ?? 10,
  });
}

describe('PerformanceMonitorService', () => {
  describe('registro de requisições e agregação', () => {
    it('soma o total de requisições e o tempo acumulado', () => {
      const service = makeService(makeCache());

      rec(service, { durationMs: 10 });
      rec(service, { durationMs: 30 });

      const snap = service.getSnapshot();
      expect(snap.requests.total).toBe(2);
      // média = (10 + 30) / 2 = 20
      expect(snap.latencyMs.average).toBe(20);
    });

    it('conta erro de servidor (status 500+) e ignora erro do cliente (4xx)', () => {
      const service = makeService(makeCache());

      rec(service, { statusCode: 200 });
      rec(service, { statusCode: 404 }); // 4xx não é erro de servidor
      rec(service, { statusCode: 500 });
      rec(service, { statusCode: 503 });

      const snap = service.getSnapshot();
      expect(snap.requests.total).toBe(4);
      expect(snap.requests.errors5xx).toBe(2);
      expect(snap.requests.errorRate).toBeCloseTo(2 / 4);
    });

    it('agrupa rotas com ID numérico e UUID no caminho', () => {
      const service = makeService(makeCache());

      // 5 hits para entrar no ranking (filtro count >= 5)
      for (let i = 0; i < 5; i++) rec(service, { path: '/api/v1/users/123', durationMs: 100 });
      for (let i = 0; i < 5; i++) rec(service, { path: '/api/v1/users/456', durationMs: 100 });

      const snap = service.getSnapshot();
      const userRoutes = snap.topSlowRoutes.filter((r) => r.path === '/api/v1/users/:id');
      expect(userRoutes).toHaveLength(1);
      // as 10 requisições caíram todas na mesma rota normalizada
      expect(userRoutes[0].count).toBe(10);
    });

    it('normaliza UUID e remove a query string do caminho', () => {
      const service = makeService(makeCache());
      const uuid = '550e8400-e29b-41d4-a716-446655440000';

      for (let i = 0; i < 5; i++) {
        rec(service, { path: `/api/v1/events/${uuid}?foo=bar`, durationMs: 100 });
      }

      const snap = service.getSnapshot();
      const route = snap.topSlowRoutes.find((r) => r.path === '/api/v1/events/:uuid');
      expect(route).toBeDefined();
      expect(route?.count).toBe(5);
    });

    it('ignora a própria rota de monitoramento de performance', () => {
      const service = makeService(makeCache());

      rec(service, { path: '/api/v1/health/performance' });
      rec(service, { path: '/api/v1/health/performance/extra' });

      const snap = service.getSnapshot();
      expect(snap.requests.total).toBe(0);
    });

    it('agrega contagem, erros, tempo total e máximo por rota', () => {
      const service = makeService(makeCache());

      rec(service, { path: '/api/v1/pay', durationMs: 50, statusCode: 200 });
      rec(service, { path: '/api/v1/pay', durationMs: 150, statusCode: 500 });
      rec(service, { path: '/api/v1/pay', durationMs: 100, statusCode: 200 });
      rec(service, { path: '/api/v1/pay', durationMs: 200, statusCode: 200 });
      rec(service, { path: '/api/v1/pay', durationMs: 300, statusCode: 200 });

      const snap = service.getSnapshot();
      const pay = snap.topSlowRoutes.find((r) => r.path === '/api/v1/pay');
      expect(pay).toBeDefined();
      expect(pay?.count).toBe(5);
      // média = (50+150+100+200+300)/5 = 160
      expect(pay?.avgLatencyMs).toBe(160);
      expect(pay?.maxLatencyMs).toBe(300);
      expect(pay?.errorRate).toBeCloseTo(1 / 5);
    });
  });

  describe('resumo (snapshot) e percentis', () => {
    it('sem nenhuma amostra devolve zeros e não quebra com divisão por zero', () => {
      const service = makeService(makeCache());

      const snap = service.getSnapshot();
      expect(snap.requests.total).toBe(0);
      expect(snap.requests.errors5xx).toBe(0);
      expect(snap.requests.errorRate).toBe(0);
      expect(snap.latencyMs.average).toBe(0);
      expect(snap.latencyMs.p95Approx).toBe(0);
      expect(snap.topSlowRoutes).toEqual([]);
    });

    it('estima o p95 caindo no bucket correto de latência', () => {
      const service = makeService(makeCache());

      // 95 requisições rápidas (<=25ms) e 5 lentas (~5000ms).
      // p95 deve "alcançar" o limite onde fica o 95º percentil.
      for (let i = 0; i < 95; i++) rec(service, { durationMs: 10 });
      for (let i = 0; i < 5; i++) rec(service, { durationMs: 5000 });

      const snap = service.getSnapshot();
      // threshold = ceil(100 * 0.95) = 95 → cumulativo chega a 95 já no 1º bucket (<=25ms)
      expect(snap.latencyMs.p95Approx).toBe(25);
    });

    it('p95 escala para um bucket alto quando há muitas requisições lentas', () => {
      const service = makeService(makeCache());

      // 50 rápidas (<=25) e 50 lentas (~2000ms → bucket 3000)
      for (let i = 0; i < 50; i++) rec(service, { durationMs: 10 });
      for (let i = 0; i < 50; i++) rec(service, { durationMs: 2000 });

      const snap = service.getSnapshot();
      // threshold = ceil(100 * 0.95) = 95 → cumulativo só atinge 95 no bucket dos lentos
      expect(snap.latencyMs.p95Approx).toBe(3000);
    });

    it('lida com valor extremo acima do maior bucket (cai no overflow)', () => {
      const service = makeService(makeCache());

      // Acima do maior limite (10000ms) → vai pro último bucket (overflow)
      for (let i = 0; i < 10; i++) rec(service, { durationMs: 999999 });

      const snap = service.getSnapshot();
      // p95 deve devolver o teto da escala de buckets
      expect(snap.latencyMs.p95Approx).toBe(10000);
      expect(snap.latencyMs.average).toBe(999999);
    });

    it('só inclui no ranking rotas com volume mínimo (count >= 5) e ordena pela média desc', () => {
      const service = makeService(makeCache());

      // Rota A: pouco volume (4 hits) → não entra no ranking
      for (let i = 0; i < 4; i++) rec(service, { path: '/api/v1/a', durationMs: 9999 });
      // Rota B: 5 hits, média 100
      for (let i = 0; i < 5; i++) rec(service, { path: '/api/v1/b', durationMs: 100 });
      // Rota C: 5 hits, média 500 (mais lenta)
      for (let i = 0; i < 5; i++) rec(service, { path: '/api/v1/c', durationMs: 500 });

      const snap = service.getSnapshot();
      const paths = snap.topSlowRoutes.map((r) => r.path);
      expect(paths).not.toContain('/api/v1/a'); // volume baixo, filtrado
      expect(paths).toContain('/api/v1/b');
      expect(paths).toContain('/api/v1/c');
      // C (média 500) antes de B (média 100)
      expect(paths.indexOf('/api/v1/c')).toBeLessThan(paths.indexOf('/api/v1/b'));
    });

    it('expõe campos estruturais esperados do resumo (memória, cpu, event loop, uptime)', () => {
      const service = makeService(makeCache());
      rec(service);

      const snap = service.getSnapshot();
      expect(typeof snap.collectedAt).toBe('string');
      expect(typeof snap.uptimeSeconds).toBe('number');
      expect(snap.memoryBytes).toHaveProperty('rss');
      expect(snap.memoryBytes).toHaveProperty('heapUsed');
      expect(snap.cpu).toHaveProperty('userMicros');
      expect(snap.eventLoop).toHaveProperty('utilization');
      expect(snap.eventLoop.delayMs).toHaveProperty('p95');
    });
  });

  describe('persistência no Redis (salvar/flush)', () => {
    // flushToRedis é privado; exercitamos via onModuleDestroy, que faz o flush final.
    async function flush(service: PerformanceMonitorService) {
      await service.onModuleDestroy();
    }

    it('não salva nada quando não houve nenhuma requisição (nada "sujo")', async () => {
      const cache = makeCache();
      const service = makeService(cache);

      await flush(service);
      expect(cache.setJson).not.toHaveBeenCalled();
    });

    it('salva o snapshot quando houve requisições e o Redis está disponível', async () => {
      const cache = makeCache({ isAvailable: jest.fn().mockReturnValue(true) });
      const service = makeService(cache);

      rec(service, { path: '/api/v1/orders', durationMs: 42, statusCode: 200 });
      await flush(service);

      expect(cache.setJson).toHaveBeenCalledTimes(1);
      const [key, payload, ttl] = cache.setJson.mock.calls[0];
      expect(key).toBe('perf:monitor:v1');
      expect(ttl).toBe(30 * 24 * 60 * 60);
      expect(payload.version).toBe(1);
      expect(payload.totalRequests).toBe(1);
      expect(payload.totalDurationMs).toBe(42);
      expect(Array.isArray(payload.routes)).toBe(true);
      expect(payload.routes[0].path).toBe('/api/v1/orders');
    });

    it('NÃO salva quando o Redis está indisponível, mesmo com dados (fail-open)', async () => {
      const cache = makeCache({ isAvailable: jest.fn().mockReturnValue(false) });
      const service = makeService(cache);

      rec(service, { path: '/api/v1/orders' });
      await flush(service);

      expect(cache.setJson).not.toHaveBeenCalled();
    });
  });

  describe('hidratação a partir do Redis (carregar)', () => {
    it('começa do zero quando o Redis não devolve nada (fail-open)', async () => {
      const cache = makeCache({ getJson: jest.fn().mockResolvedValue(null) });
      const service = makeService(cache);

      await service.onModuleInit();

      const snap = service.getSnapshot();
      expect(snap.requests.total).toBe(0);

      await service.onModuleDestroy();
    });

    it('re-popula contadores e rotas a partir de um snapshot válido', async () => {
      const bucketsLen = 9; // latencyBucketsMs (8) + 1 overflow
      const persisted = {
        version: 1,
        totalRequests: 100,
        totalErrors: 7,
        totalDurationMs: 5000,
        globalBuckets: Array(bucketsLen).fill(0).map((_, i) => (i === 0 ? 100 : 0)),
        routes: [
          {
            key: 'GET /api/v1/orders',
            method: 'GET',
            path: '/api/v1/orders',
            count: 100,
            errorCount: 7,
            totalDurationMs: 5000,
            maxDurationMs: 800,
            buckets: Array(bucketsLen).fill(0).map((_, i) => (i === 0 ? 100 : 0)),
          },
        ],
        persistedAt: new Date().toISOString(),
      };
      const cache = makeCache({ getJson: jest.fn().mockResolvedValue(persisted) });
      const service = makeService(cache);

      await service.onModuleInit();

      const snap = service.getSnapshot();
      expect(snap.requests.total).toBe(100);
      expect(snap.requests.errors5xx).toBe(7);
      // média = 5000 / 100 = 50
      expect(snap.latencyMs.average).toBe(50);
      const orders = snap.topSlowRoutes.find((r) => r.path === '/api/v1/orders');
      expect(orders?.count).toBe(100);
      expect(orders?.maxLatencyMs).toBe(800);

      // limpa o timer de flush criado no onModuleInit
      await service.onModuleDestroy();
    });

    it('ignora snapshot com versão incompatível (sem quebrar o boot)', async () => {
      const cache = makeCache({
        getJson: jest.fn().mockResolvedValue({ version: 999, totalRequests: 42, globalBuckets: [] }),
      });
      const service = makeService(cache);

      await service.onModuleInit();

      const snap = service.getSnapshot();
      expect(snap.requests.total).toBe(0); // ignorou o snapshot

      await service.onModuleDestroy();
    });

    it('ignora snapshot cujo formato de buckets é diferente (mudou a config de buckets)', async () => {
      const cache = makeCache({
        getJson: jest.fn().mockResolvedValue({
          version: 1,
          totalRequests: 42,
          totalErrors: 1,
          totalDurationMs: 100,
          globalBuckets: [1, 2, 3], // tamanho errado
          routes: [],
          persistedAt: new Date().toISOString(),
        }),
      });
      const service = makeService(cache);

      await service.onModuleInit();

      const snap = service.getSnapshot();
      expect(snap.requests.total).toBe(0); // ignorou por shape incompatível

      await service.onModuleDestroy();
    });

    it('descarta rotas individuais com buckets de tamanho divergente, mantendo os totais válidos', async () => {
      const bucketsLen = 9;
      const goodBuckets = Array(bucketsLen).fill(0).map((_, i) => (i === 0 ? 10 : 0));
      const cache = makeCache({
        getJson: jest.fn().mockResolvedValue({
          version: 1,
          totalRequests: 10,
          totalErrors: 0,
          totalDurationMs: 100,
          globalBuckets: goodBuckets,
          routes: [
            {
              key: 'GET /api/v1/bad',
              method: 'GET',
              path: '/api/v1/bad',
              count: 5,
              errorCount: 0,
              totalDurationMs: 50,
              maxDurationMs: 20,
              buckets: [1, 2], // tamanho errado → rota descartada
            },
          ],
          persistedAt: new Date().toISOString(),
        }),
      });
      const service = makeService(cache);

      await service.onModuleInit();

      const snap = service.getSnapshot();
      // totais foram hidratados
      expect(snap.requests.total).toBe(10);
      // mas a rota com buckets ruins não entrou
      expect(snap.topSlowRoutes.find((r) => r.path === '/api/v1/bad')).toBeUndefined();

      await service.onModuleDestroy();
    });
  });
});
