import type { PrismaClient } from '@prisma/client';

type AuditClient = Pick<PrismaClient, 'organizationAuditLog' | 'organizationMember'>;

/** Folga para trás: o log de criação é gravado DEPOIS do `event.create`, mas relógios
 *  de app e banco podem divergir por alguns segundos. */
const CREATED_AT_SKEW_MS = 60 * 1000;

/**
 * E-mail do COLABORADOR que está criando o evento — para somar aos destinatários
 * das notificações de auditoria (em análise, ajustes solicitados, publicado).
 *
 * O `Event` não tem coluna de autor; a fonte é a trilha `OrganizationAuditLog`:
 * o primeiro log `EVENT_CREATE` do evento, ou — em evento criado antes da trilha
 * existir — o primeiro `EVENT_PUBLISH` (envio para análise). Evita migration e cobre
 * os eventos que já existem.
 *
 * Performance: `occurredAt >= createdAt` + `orderBy asc` + `take 1` percorre o índice
 * `[organizationId, occurredAt]` a partir da criação do evento e para no primeiro
 * log que casar — o de criação costuma estar a segundos dali.
 *
 * Só devolve o e-mail se o autor AINDA for membro da organização: colaborador
 * removido não continua recebendo aviso de evento que não é mais dele.
 *
 * Best-effort: qualquer falha devolve `null` e o envio segue para org + owners.
 * Trade-off: a auditoria é best-effort na gravação (`OrganizationAuditService.record`);
 * se o log de criação se perdeu, o colaborador simplesmente não é incluído.
 */
export async function findEventCreatorMemberEmail(
  client: AuditClient,
  params: { organizationId: string; eventId: string; eventCreatedAt: Date },
): Promise<string | null> {
  try {
    const log = await client.organizationAuditLog.findFirst({
      where: {
        organizationId: params.organizationId,
        actorUserId: { not: null },
        occurredAt: {
          gte: new Date(params.eventCreatedAt.getTime() - CREATED_AT_SKEW_MS),
        },
        AND: [
          { metadata: { path: ['eventId'], equals: params.eventId } },
          {
            OR: [
              { metadata: { path: ['kind'], equals: 'EVENT_CREATE' } },
              { metadata: { path: ['kind'], equals: 'EVENT_PUBLISH' } },
            ],
          },
        ],
      },
      orderBy: { occurredAt: 'asc' },
      select: { actorUserId: true },
    });
    if (!log?.actorUserId) return null;

    const member = await client.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: params.organizationId,
          userId: log.actorUserId,
        },
      },
      select: { user: { select: { email: true } } },
    });
    return member?.user?.email ?? null;
  } catch {
    return null;
  }
}
