import type { PrismaClient } from '@prisma/client';

/** Fragmento de regex (sem ^/$) para UUID de Event. */
const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

/** Primeiro segmento após `.../edit/` → rótulo em pt-BR (minúsculas para compor "edição de …"). */
const EVENT_EDIT_SECTION_LABEL: Record<string, string> = {
  banner: 'banner',
  logo: 'logo',
  general: 'dados gerais',
  info: 'informações',
  details: 'detalhes',
  location: 'local',
  date: 'data',
  dates: 'datas',
  registration: 'inscrições',
  tickets: 'ingressos',
  modalities: 'modalidades',
  kits: 'kits',
  products: 'produtos',
  coupons: 'cupons',
  vouchers: 'vouchers',
  questions: 'perguntas',
  regulation: 'regulamento',
  notifications: 'notificações',
  settings: 'configurações',
  publish: 'publicação',
  financial: 'financeiro',
  participants: 'participantes',
  orders: 'pedidos',
};

/**
 * Rotas `events/<id>/<algo>` sem `edit` (ex.: inscritos, pedidos).
 * Primeiro segmento após o id do evento.
 */
const EVENT_SUBPAGE_LABEL: Record<string, string> = {
  registrations: 'registros',
  registration: 'inscrições',
  participants: 'participantes',
  orders: 'pedidos',
  financial: 'financeiro',
  finance: 'financeiro',
  modalities: 'modalidades',
  tickets: 'ingressos',
  kits: 'kits',
  products: 'produtos',
  coupons: 'cupons',
  vouchers: 'vouchers',
  questions: 'perguntas',
  analytics: 'análises',
  reports: 'relatórios',
  settings: 'configurações',
  notifications: 'notificações',
  checkout: 'checkout',
  dashboard: 'painel do evento',
  summary: 'resumo',
  overview: 'visão geral',
};

const STATIC_PAGE_LABEL: Record<string, string> = {
  dashboard: 'Painel inicial',
  events: 'Lista de eventos',
  organization: 'Dados da organização',
  members: 'Equipe e permissões',
  profile: 'Perfil do organizador',
  settings: 'Configurações',
  finance: 'Financeiro',
};

/**
 * Transforma `pageKey` do front (ex.: `events/<id>/edit/banner`) em texto para o audit log.
 * Só resolve nome de evento se o evento pertencer à organização.
 */
export async function resolveOrganizerPageViewActionLabel(
  prismaRead: PrismaClient,
  organizationId: string,
  pageKey: string,
): Promise<string> {
  const key = pageKey.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!key) {
    return 'Acessou uma página do painel';
  }

  const lower = key.toLowerCase();
  if (STATIC_PAGE_LABEL[lower]) {
    return `Acessou a página ${STATIC_PAGE_LABEL[lower]}`;
  }

  const eventsEdit = new RegExp(
    `^events/(${UUID_PATTERN})/edit(?:/(.+))?$`,
    'i',
  ).exec(key);
  if (eventsEdit) {
    const eventId = eventsEdit[1];
    const rest = (eventsEdit[2] ?? '').replace(/\/+$/, '');
    const event = await prismaRead.event.findFirst({
      where: { id: eventId, organizationId },
      select: { name: true },
    });
    const eventName = event?.name ?? 'evento (não encontrado ou sem permissão)';

    if (!rest) {
      return `Acessou a página de edição do evento "${eventName}"`;
    }

    const ticketsWithId = new RegExp(
      `^tickets/(${UUID_PATTERN})(?:/.*)?$`,
      'i',
    ).exec(rest);
    if (ticketsWithId) {
      const ticketId = ticketsWithId[1];
      const ticket = await prismaRead.ticket.findFirst({
        where: {
          id: ticketId,
          eventId,
          event: { organizationId },
        },
        select: { name: true },
      });
      const ticketName =
        ticket?.name ?? 'ingresso (não encontrado ou sem permissão)';
      return `Acessou a página de edição do ingresso "${ticketName}" do evento "${eventName}"`;
    }

    const firstSeg = rest.split('/')[0].toLowerCase();
    const section =
      EVENT_EDIT_SECTION_LABEL[firstSeg] ??
      firstSeg.replace(/-/g, ' ');
    return `Acessou a página de edição de ${section} do evento "${eventName}"`;
  }

  const eventsWithSubpath = new RegExp(
    `^events/(${UUID_PATTERN})/(.+)$`,
    'i',
  ).exec(key);
  if (eventsWithSubpath) {
    const eventId = eventsWithSubpath[1];
    const rest = eventsWithSubpath[2].replace(/\/+$/, '');
    const firstSeg = rest.split('/')[0].toLowerCase();
    if (firstSeg !== 'edit') {
      const event = await prismaRead.event.findFirst({
        where: { id: eventId, organizationId },
        select: { name: true },
      });
      const eventName = event?.name ?? 'evento (não encontrado ou sem permissão)';
      const subLabel =
        EVENT_SUBPAGE_LABEL[firstSeg] ?? firstSeg.replace(/-/g, ' ');
      return `Acessou a página de ${subLabel} do evento "${eventName}"`;
    }
  }

  const eventsDetail = new RegExp(`^events/(${UUID_PATTERN})$`, 'i').exec(key);
  if (eventsDetail) {
    const eventId = eventsDetail[1];
    const event = await prismaRead.event.findFirst({
      where: { id: eventId, organizationId },
      select: { name: true },
    });
    const eventName = event?.name ?? 'evento (não encontrado ou sem permissão)';
    return `Acessou a página do evento "${eventName}"`;
  }

  return `Acessou a página "${key}"`;
}
