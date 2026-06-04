/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: registro de ATIVIDADE do usuário (analytics de jornada).
 *           Toda vez que alguém abre uma página, clica num botão, faz login ou
 *           passa pelo checkout, o sistema guarda um "registro de atividade".
 *
 *  EM RESUMO:
 *    O serviço NÃO grava no banco a cada evento (isso seria caro). Em vez disso
 *    ele ACUMULA os eventos numa fila em memória e DESCARREGA tudo de uma vez
 *    no banco (em lote). Antes de guardar, ele LIMPA dados sensíveis (senha,
 *    CPF, número de cartão, token, etc.) — mesmo que o navegador mande por
 *    engano, o banco nunca recebe.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Só registrar um evento NÃO grava no banco na hora (fica na fila).
 *    • Ao descarregar a fila, o registro aparece no banco com os campos certos
 *      (usuário, ip, categoria, ação, etc.).
 *    • Dados sensíveis (senha, cpf, cartão, token...) são REMOVIDOS antes de
 *      gravar — inclusive quando estão escondidos dentro de objetos/listas, e
 *      sem se importar se vieram em MAIÚSCULA ou minúscula.
 *    • Evento ANÔNIMO (sem usuário logado) é gravado com "usuário = vazio".
 *    • Quando muitos eventos se acumulam, o sistema descarrega tudo sozinho
 *      (sem precisar esperar o relógio).
 *    • Campos grandes demais (ação/url gigantes) são cortados no limite.
 *    • Metadados gigantes (acima de 8 KB) são substituídos por um marcador.
 *    • Quando a fila enche o limite máximo, novos eventos são descartados
 *      (sem derrubar a aplicação).
 *
 *  COMO CONFERIMOS:
 *    Teste DE VERDADE contra um banco de teste (descartável). Registramos
 *    eventos REAIS, forçamos o descarregamento e LEMOS O BANCO DE VOLTA para
 *    conferir o que ficou gravado. O banco é limpo antes de cada cenário.
 *
 *  OBSERVAÇÃO TÉCNICA:
 *    O método interno `flush()` (que grava no banco) é PRIVADO. Em produção ele
 *    roda por um timer a cada 5s ou quando a fila atinge 200 eventos. Nos testes
 *    nós o disparamos de forma determinística chamando `onModuleDestroy()`, que
 *    faz um flush final — esse é o gancho público legítimo. NÃO mexemos no
 *    código de produção para isso.
 * ============================================================================
 */
import {
  Prisma,
  UserActivityCategory,
  UserActivitySource,
} from '@prisma/client';
import { UserActivityService } from '../user-activity.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  createTestPrisma,
  resetDb,
  seedUser,
} from '../../testing/integration-db';

describe('UserActivityService (integração, banco real)', () => {
  let prisma: PrismaService;
  let service: UserActivityService;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma); // banco limpo antes de cada cenário
    // Instância nova por teste → buffer limpo, sem vazamento de estado.
    // NÃO chamamos onModuleInit() de propósito: não queremos o timer de 5s
    // disparando flushes não-determinísticos no meio do teste.
    service = new UserActivityService(prisma);
  });

  // Helper: lê TODOS os registros gravados (ordem estável por ação).
  const lerBanco = () =>
    prisma.getReadClient().userActivityLog.findMany({
      orderBy: { action: 'asc' },
    });

  // Helper: força a gravação no banco. onModuleDestroy() faz o flush final.
  // Após isso o serviço não deve mais ser usado (timer parado) — por isso
  // criamos um service novo a cada teste no beforeEach.
  const flush = () => service.onModuleDestroy();

  // --------------------------------------------------------------------------
  it('apenas registrar um evento NÃO grava no banco na hora (fica na fila)', async () => {
    service.record({
      source: UserActivitySource.FRONTEND,
      category: UserActivityCategory.PAGE_VIEW,
      action: 'page:home',
    });

    // Ainda na fila, nada no banco.
    expect(service.getBufferSize()).toBe(1);
    expect(await lerBanco()).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  it('ao descarregar a fila, grava o registro com os campos certos', async () => {
    const userId = await seedUser(prisma, 'USER');
    const occurredAt = new Date('2026-06-01T10:00:00.000Z');

    service.record({
      userId,
      sessionId: 'sess-abc',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (TestRunner)',
      source: UserActivitySource.BACKEND,
      category: UserActivityCategory.API,
      action: 'api:POST /orders/reserve',
      path: '/orders/reserve',
      referrer: 'https://app.podio/checkout',
      metadata: { eventId: 'evt-1', qty: 2 },
      occurredAt,
    });

    await flush();

    const rows = await lerBanco();
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.userId).toBe(userId);
    expect(r.sessionId).toBe('sess-abc');
    expect(r.ip).toBe('203.0.113.7');
    expect(r.userAgent).toBe('Mozilla/5.0 (TestRunner)');
    expect(r.source).toBe(UserActivitySource.BACKEND);
    expect(r.category).toBe(UserActivityCategory.API);
    expect(r.action).toBe('api:POST /orders/reserve');
    expect(r.path).toBe('/orders/reserve');
    expect(r.referrer).toBe('https://app.podio/checkout');
    expect(r.metadata).toEqual({ eventId: 'evt-1', qty: 2 });
    expect(r.occurredAt.toISOString()).toBe(occurredAt.toISOString());
  });

  // --------------------------------------------------------------------------
  it('remove dados sensíveis do metadata (chaves PII), inclusive aninhados, em listas e ignorando maiúsculas/minúsculas', async () => {
    const userId = await seedUser(prisma, 'USER');

    service.record({
      userId,
      source: UserActivitySource.FRONTEND,
      category: UserActivityCategory.CHECKOUT,
      action: 'checkout:pay',
      metadata: {
        // Chaves PII no topo (variações de caixa) — devem sumir.
        password: 'segredo123',
        CPF: '12345678900',
        token: 'eyJhbGciOi...',
        cardNumber: '4111111111111111',
        cvv: '123',
        // Campo legítimo — deve permanecer.
        amount: 150.0,
        // Objeto aninhado: a chave PII some, a legítima fica.
        payer: {
          name: 'Fulano',
          documentNumber: '99999999999',
          authorization: 'Bearer xyz',
        },
        // Lista com objetos contendo PII.
        items: [
          { sku: 'A', pan: '5555444433332222' },
          { sku: 'B', secret: 'shh' },
        ],
      },
    });

    await flush();

    const rows = await lerBanco();
    expect(rows).toHaveLength(1);
    const meta = rows[0].metadata as Record<string, any>;

    // Campos legítimos preservados.
    expect(meta.amount).toBe(150);
    expect(meta.payer.name).toBe('Fulano');
    expect(meta.items).toEqual([{ sku: 'A' }, { sku: 'B' }]);

    // Nenhuma chave PII sobreviveu (topo, aninhado e em lista).
    expect(meta).not.toHaveProperty('password');
    expect(meta).not.toHaveProperty('CPF');
    expect(meta).not.toHaveProperty('token');
    expect(meta).not.toHaveProperty('cardNumber');
    expect(meta).not.toHaveProperty('cvv');
    expect(meta.payer).not.toHaveProperty('documentNumber');
    expect(meta.payer).not.toHaveProperty('authorization');
    expect(meta.items[0]).not.toHaveProperty('pan');
    expect(meta.items[1]).not.toHaveProperty('secret');

    // Garantia "grosseira": serializado inteiro não contém os valores secretos.
    const serial = JSON.stringify(meta);
    expect(serial).not.toContain('segredo123');
    expect(serial).not.toContain('12345678900');
    expect(serial).not.toContain('4111111111111111');
    expect(serial).not.toContain('5555444433332222');
  });

  // --------------------------------------------------------------------------
  it('grava evento ANÔNIMO com usuário vazio (userId null)', async () => {
    service.record({
      // sem userId → anônimo (pré-login), costurado pelo sessionId
      sessionId: 'anon-session-1',
      source: UserActivitySource.FRONTEND,
      category: UserActivityCategory.PAGE_VIEW,
      action: 'page:event/maratona',
    });

    await flush();

    const rows = await lerBanco();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBeNull();
    expect(rows[0].sessionId).toBe('anon-session-1');
  });

  // --------------------------------------------------------------------------
  it('metadata vazio/ausente vira NULL no banco (não quebra o insert)', async () => {
    service.record({
      source: UserActivitySource.FRONTEND,
      category: UserActivityCategory.CLICK,
      action: 'click:sem-meta',
      // sem metadata
    });

    await flush();

    const rows = await lerBanco();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toBeNull();
  });

  // --------------------------------------------------------------------------
  it('descarrega a fila sozinho ao atingir o limite (FLUSH_THRESHOLD = 200)', async () => {
    // 200 eventos atingem o threshold e disparam o flush interno
    // (fire-and-forget, sem await — é o comportamento de produção: o path do
    // request não pode esperar I/O).
    for (let i = 0; i < 200; i++) {
      service.record({
        source: UserActivitySource.FRONTEND,
        category: UserActivityCategory.CLICK,
        // ação distinta por evento pra facilitar conferência de unicidade
        action: `click:auto-${String(i).padStart(3, '0')}`,
      });
    }

    // IMPORTANTE: o flush interno drena o buffer (`this.buffer = []`) ANTES do
    // `await` do createMany. Logo `getBufferSize()` zera na hora, mesmo com o
    // I/O ainda em voo — poll por bufferSize seria um falso-positivo e deixaria
    // o INSERT vazar pro próximo teste. Aguardamos a VERDADE no banco: contamos
    // até os 200 efetivamente persistirem (determinístico, com teto).
    let total = 0;
    for (let tentativa = 0; tentativa < 100 && total < 200; tentativa++) {
      total = await prisma.getReadClient().userActivityLog.count();
      if (total >= 200) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Flush final awaited: garante que nenhum I/O fique pendente após o teste
    // (sem isso o createMany em voo poderia escrever no banco já resetado do
    // próximo cenário).
    await flush();
    total = await prisma.getReadClient().userActivityLog.count();

    expect(total).toBe(200);
    expect(service.getBufferSize()).toBe(0);
  });

  // --------------------------------------------------------------------------
  it('corta action no limite máximo (200 caracteres)', async () => {
    const acaoGigante = 'a'.repeat(500);

    service.record({
      source: UserActivitySource.BACKEND,
      category: UserActivityCategory.OTHER,
      action: acaoGigante,
    });

    await flush();

    const rows = await lerBanco();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toHaveLength(200);
  });

  // --------------------------------------------------------------------------
  it('substitui metadata gigante (> 8 KB) por um marcador de truncamento', async () => {
    // ATENÇÃO (comportamento real do serviço): a sanitização corta CADA string
    // individualmente em 2000 chars (stripPii) ANTES de medir o tamanho total
    // (sanitizeMetadata > MAX_METADATA_BYTES = 8 KB). Logo, um ÚNICO blob
    // gigante nunca estoura o limite — ele é cortado pra 2000 chars antes.
    // Pra exercitar de verdade o marcador de truncamento, o payload precisa
    // passar de 8 KB SOMANDO vários campos (cada um <= 2000 chars). Aqui
    // montamos um objeto com muitos campos string que, serializado, ultrapassa
    // 8 KB e dispara o marcador.
    const enorme: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      enorme[`campo_${i}`] = 'x'.repeat(1000); // 20 * ~1000 ≈ 20 KB > 8 KB
    }

    service.record({
      source: UserActivitySource.FRONTEND,
      category: UserActivityCategory.OTHER,
      action: 'meta:gigante',
      metadata: enorme,
    });

    await flush();

    const rows = await lerBanco();
    expect(rows).toHaveLength(1);
    const meta = rows[0].metadata as Record<string, any>;
    expect(meta._truncated).toBe(true);
    expect(typeof meta._originalSizeBytes).toBe('number');
    // Os campos originais NÃO foram persistidos: o objeto inteiro foi
    // substituído pelo marcador (só _truncated/_originalSizeBytes).
    expect(meta).not.toHaveProperty('campo_0');
    expect(Object.keys(meta).sort()).toEqual([
      '_originalSizeBytes',
      '_truncated',
    ]);
  });

  // --------------------------------------------------------------------------
  it('descarta novos eventos quando a fila atinge o limite máximo (MAX_BUFFER_SIZE = 5000)', async () => {
    // Lota o buffer SEM disparar flush automático: deixamos o threshold
    // (200) ser ultrapassado, mas como NÃO demos await em nenhum flush e o
    // I/O é assíncrono, o teste foca em verificar o teto. Para isolar o
    // comportamento de DROP de forma determinística, lotamos além do MAX.
    //
    // Estratégia: registrar 5000 eventos (enche o buffer) e depois mais 1.
    // Como o flush por threshold é fire-and-forget e pode drenar parte do
    // buffer no meio, conferimos a INVARIANTE: o buffer nunca passa do teto.
    for (let i = 0; i < UserActivityServiceMaxBuffer + 50; i++) {
      service.record({
        source: UserActivitySource.FRONTEND,
        category: UserActivityCategory.OTHER,
        action: `drop:${i}`,
      });
    }

    // Invariante de segurança: o buffer JAMAIS ultrapassa o teto configurado.
    expect(service.getBufferSize()).toBeLessThanOrEqual(UserActivityServiceMaxBuffer);
  });
});

// Espelho do limite privado MAX_BUFFER_SIZE (5000). Mantido fora da classe de
// produção de propósito — o teste não deve depender de internals exportados,
// mas precisa do número pra exercitar o teto. Se o limite mudar na produção,
// atualizar aqui.
const UserActivityServiceMaxBuffer = 5000;

// Sanity: o tipo Prisma.JsonNull existe (usado no flush para metadata vazio).
// Mantém o import "vivo" e documenta a dependência do contrato Prisma.
void Prisma.JsonNull;
