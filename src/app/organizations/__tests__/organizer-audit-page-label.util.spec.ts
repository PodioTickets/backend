/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: transforma a "chave de página" que o front manda (ex.:
 *           `events/<id>/edit/banner`) em um texto amigável para o histórico
 *           de auditoria (ex.: 'Acessou a página de edição de banner do
 *           evento "Corrida"').
 *
 *  EM RESUMO:
 *    O front avisa qual página o organizador abriu usando um caminho técnico.
 *    Esta peça traduz esse caminho para uma frase em português. Quando o
 *    caminho aponta para um evento (ou ingresso), ela consulta o banco para
 *    descobrir o NOME — mas só se o evento pertencer àquela organização
 *    (senão diz "não encontrado ou sem permissão").
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Caminho vazio (ou só barras/espaços): frase genérica de painel.
 *    • Página estática conhecida (dashboard, events, finance...): rótulo fixo,
 *      sem ligar para o banco. Reconhece em maiúsculas também.
 *    • Edição de evento sem subseção: nome do evento vindo do banco.
 *    • Edição de evento quando o evento não é da org / não existe: fallback.
 *    • Edição de uma seção conhecida (banner, ingressos...) e desconhecida
 *      (vira o próprio segmento, trocando hífen por espaço).
 *    • Edição de um ingrasso específico (tickets/<id>): nome do ingresso.
 *    • Ingresso não encontrado: fallback do ingresso.
 *    • Subpágina do evento sem "edit" (registros, pedidos...): rótulo + nome.
 *    • Subpágina desconhecida: segmento com hífen virando espaço.
 *    • Página de detalhe do evento (só `events/<id>`): nome do evento.
 *    • Qualquer outro caminho desconhecido: ecoa o caminho cru.
 *
 *  COMO CONFERIMOS:
 *    Usamos um banco "de mentira" (mock do Prisma) que devolve o que mandarmos
 *    para event.findFirst / ticket.findFirst. Assim testamos só a tradução.
 * ============================================================================
 */
import type { PrismaClient } from '@prisma/client';

import { resolveOrganizerPageViewActionLabel } from '../organizer-audit-page-label.util';

const ORG_ID = 'org-123';
// UUID válido conforme o padrão exigido (versão 1-8, variante 8/9/a/b).
const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const TICKET_ID = '22222222-2222-4222-9222-222222222222';

/**
 * Cria um Prisma "de mentira" com as duas consultas usadas pela função.
 * `eventResult`/`ticketResult` definem o que cada findFirst devolve.
 */
function makePrisma(opts: {
  eventResult?: { name: string } | null;
  ticketResult?: { name: string } | null;
} = {}) {
  const eventFindFirst = jest
    .fn()
    .mockResolvedValue(opts.eventResult ?? null);
  const ticketFindFirst = jest
    .fn()
    .mockResolvedValue(opts.ticketResult ?? null);

  const prisma = {
    event: { findFirst: eventFindFirst },
    ticket: { findFirst: ticketFindFirst },
  } as unknown as PrismaClient;

  return { prisma, eventFindFirst, ticketFindFirst };
}

describe('resolveOrganizerPageViewActionLabel', () => {
  describe('caminho vazio', () => {
    it('string vazia vira a frase genérica de painel', async () => {
      const { prisma, eventFindFirst } = makePrisma();
      const out = await resolveOrganizerPageViewActionLabel(prisma, ORG_ID, '');
      expect(out).toBe('Acessou uma página do painel');
      expect(eventFindFirst).not.toHaveBeenCalled();
    });

    it('só barras e espaços também vira a frase genérica', async () => {
      const { prisma } = makePrisma();
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        '  ///  ',
      );
      expect(out).toBe('Acessou uma página do painel');
    });
  });

  describe('páginas estáticas', () => {
    it('"dashboard" usa o rótulo fixo sem consultar o banco', async () => {
      const { prisma, eventFindFirst } = makePrisma();
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        'dashboard',
      );
      expect(out).toBe('Acessou a página Painel inicial');
      expect(eventFindFirst).not.toHaveBeenCalled();
    });

    it('"events" (lista) usa o rótulo de lista de eventos', async () => {
      const { prisma } = makePrisma();
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        'events',
      );
      expect(out).toBe('Acessou a página Lista de eventos');
    });

    it('reconhece a página estática mesmo em MAIÚSCULAS', async () => {
      const { prisma } = makePrisma();
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        'FINANCE',
      );
      expect(out).toBe('Acessou a página Financeiro');
    });

    it('ignora barras nas pontas antes de casar a estática', async () => {
      const { prisma } = makePrisma();
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        '/profile/',
      );
      expect(out).toBe('Acessou a página Perfil do organizador');
    });
  });

  describe('edição de evento (events/<id>/edit...)', () => {
    it('sem subseção: traz o nome do evento do banco', async () => {
      const { prisma, eventFindFirst } = makePrisma({
        eventResult: { name: 'Corrida' },
      });
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        `events/${EVENT_ID}/edit`,
      );
      expect(out).toBe('Acessou a página de edição do evento "Corrida"');
      expect(eventFindFirst).toHaveBeenCalledWith({
        where: { id: EVENT_ID, organizationId: ORG_ID },
        select: { name: true },
      });
    });

    it('evento não encontrado / sem permissão: usa o texto de fallback', async () => {
      const { prisma } = makePrisma({ eventResult: null });
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        `events/${EVENT_ID}/edit`,
      );
      expect(out).toBe(
        'Acessou a página de edição do evento "evento (não encontrado ou sem permissão)"',
      );
    });

    it('barra final depois de /edit conta como "sem subseção"', async () => {
      const { prisma } = makePrisma({ eventResult: { name: 'Corrida' } });
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        `events/${EVENT_ID}/edit/`,
      );
      expect(out).toBe('Acessou a página de edição do evento "Corrida"');
    });

    it('seção conhecida (banner) usa o rótulo traduzido', async () => {
      const { prisma } = makePrisma({ eventResult: { name: 'Corrida' } });
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        `events/${EVENT_ID}/edit/banner`,
      );
      expect(out).toBe(
        'Acessou a página de edição de banner do evento "Corrida"',
      );
    });

    it('seção conhecida composta (registration) usa o rótulo correto', async () => {
      const { prisma } = makePrisma({ eventResult: { name: 'Corrida' } });
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        `events/${EVENT_ID}/edit/registration`,
      );
      expect(out).toBe(
        'Acessou a página de edição de inscrições do evento "Corrida"',
      );
    });

    it('seção desconhecida vira o próprio segmento com hífen virando espaço', async () => {
      const { prisma } = makePrisma({ eventResult: { name: 'Corrida' } });
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        `events/${EVENT_ID}/edit/algo-novo`,
      );
      expect(out).toBe(
        'Acessou a página de edição de algo novo do evento "Corrida"',
      );
    });

    it('seção desconhecida ignora segmentos extras após o primeiro', async () => {
      const { prisma } = makePrisma({ eventResult: { name: 'Corrida' } });
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        `events/${EVENT_ID}/edit/settings/avancado`,
      );
      expect(out).toBe(
        'Acessou a página de edição de configurações do evento "Corrida"',
      );
    });
  });

  describe('edição de ingresso (events/<id>/edit/tickets/<id>)', () => {
    it('traz o nome do ingresso e do evento', async () => {
      const { prisma, ticketFindFirst } = makePrisma({
        eventResult: { name: 'Corrida' },
        ticketResult: { name: 'Lote 1' },
      });
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        `events/${EVENT_ID}/edit/tickets/${TICKET_ID}`,
      );
      expect(out).toBe(
        'Acessou a página de edição do ingresso "Lote 1" do evento "Corrida"',
      );
      expect(ticketFindFirst).toHaveBeenCalledWith({
        where: {
          id: TICKET_ID,
          eventId: EVENT_ID,
          event: { organizationId: ORG_ID },
        },
        select: { name: true },
      });
    });

    it('ingresso não encontrado: usa o fallback do ingresso (evento ainda resolve)', async () => {
      const { prisma } = makePrisma({
        eventResult: { name: 'Corrida' },
        ticketResult: null,
      });
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        `events/${EVENT_ID}/edit/tickets/${TICKET_ID}`,
      );
      expect(out).toBe(
        'Acessou a página de edição do ingresso "ingresso (não encontrado ou sem permissão)" do evento "Corrida"',
      );
    });

    it('aceita segmentos extras após o id do ingresso', async () => {
      const { prisma } = makePrisma({
        eventResult: { name: 'Corrida' },
        ticketResult: { name: 'Lote 1' },
      });
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        `events/${EVENT_ID}/edit/tickets/${TICKET_ID}/lotes`,
      );
      expect(out).toBe(
        'Acessou a página de edição do ingresso "Lote 1" do evento "Corrida"',
      );
    });

    it('"tickets" sem id de ingresso cai como seção comum de edição', async () => {
      const { prisma, ticketFindFirst } = makePrisma({
        eventResult: { name: 'Corrida' },
      });
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        `events/${EVENT_ID}/edit/tickets`,
      );
      expect(out).toBe(
        'Acessou a página de edição de ingressos do evento "Corrida"',
      );
      expect(ticketFindFirst).not.toHaveBeenCalled();
    });
  });

  describe('subpágina do evento sem "edit" (events/<id>/<algo>)', () => {
    it('subpágina conhecida (registrations) usa o rótulo + nome do evento', async () => {
      const { prisma } = makePrisma({ eventResult: { name: 'Corrida' } });
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        `events/${EVENT_ID}/registrations`,
      );
      expect(out).toBe('Acessou a página de registros do evento "Corrida"');
    });

    it('subpágina desconhecida vira o segmento com hífen virando espaço', async () => {
      const { prisma } = makePrisma({ eventResult: { name: 'Corrida' } });
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        `events/${EVENT_ID}/algo-estranho`,
      );
      expect(out).toBe(
        'Acessou a página de algo estranho do evento "Corrida"',
      );
    });

    it('subpágina com evento não encontrado usa o fallback do evento', async () => {
      const { prisma } = makePrisma({ eventResult: null });
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        `events/${EVENT_ID}/orders`,
      );
      expect(out).toBe(
        'Acessou a página de pedidos do evento "evento (não encontrado ou sem permissão)"',
      );
    });
  });

  describe('detalhe do evento (events/<id>)', () => {
    it('traz o nome do evento', async () => {
      const { prisma, eventFindFirst } = makePrisma({
        eventResult: { name: 'Corrida' },
      });
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        `events/${EVENT_ID}`,
      );
      expect(out).toBe('Acessou a página do evento "Corrida"');
      expect(eventFindFirst).toHaveBeenCalledWith({
        where: { id: EVENT_ID, organizationId: ORG_ID },
        select: { name: true },
      });
    });

    it('evento não encontrado usa o fallback', async () => {
      const { prisma } = makePrisma({ eventResult: null });
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        `events/${EVENT_ID}`,
      );
      expect(out).toBe(
        'Acessou a página do evento "evento (não encontrado ou sem permissão)"',
      );
    });
  });

  describe('fallback para caminhos desconhecidos', () => {
    it('ecoa o caminho cru quando nada casa', async () => {
      const { prisma, eventFindFirst } = makePrisma();
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        'alguma/rota/qualquer',
      );
      expect(out).toBe('Acessou a página "alguma/rota/qualquer"');
      expect(eventFindFirst).not.toHaveBeenCalled();
    });

    it('events com id que não é UUID cai no fallback', async () => {
      const { prisma } = makePrisma();
      const out = await resolveOrganizerPageViewActionLabel(
        prisma,
        ORG_ID,
        'events/nao-e-uuid/edit/banner',
      );
      expect(out).toBe('Acessou a página "events/nao-e-uuid/edit/banner"');
    });
  });
});
