import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OrganizerMemberAccessService } from '../organizations/organizer-member-access.service';
import { EmailService } from '../../common/services/email.service';
import {
  CreateEventNotificationDto,
  EVENT_NOTIFICATION_CHANNEL_VALUES,
  ListEventNotificationsQueryDto,
} from './dto/event-notification.dto';
import {
  plainTextFromHtml,
  sanitizeEventNotificationHtml,
} from './event-notification-html';
import type { PrismaClient } from '@prisma/client';

const TITLE_MAX = 200;
const MESSAGE_MAX_BYTES = 102400;

type NotificationListRow = {
  id: string;
  occurredAt: Date;
  title: string;
  channels: string[];
  status: string;
};

type NotificationDetailRow = NotificationListRow & { messageHtml: string };

/** Delegate gerado pelo Prisma após `prisma generate` (model `EventNotification`). */
function eventNotifications(client: PrismaClient) {
  return (client as PrismaClient & {
    eventNotification: {
      findMany: (args: {
        where: object;
        skip?: number;
        take?: number;
        orderBy: object;
        select: object;
      }) => Promise<NotificationListRow[]>;
      count: (args: { where: object }) => Promise<number>;
      findFirst: (args: {
        where: object;
        select: object;
      }) => Promise<NotificationDetailRow | null>;
      create: (args: {
        data: {
          eventId: string;
          title: string;
          messageHtml: string;
          channels: string[];
          status: string;
          createdById: string;
        };
        select: object;
      }) => Promise<NotificationListRow>;
    };
  }).eventNotification;
}

@Injectable()
export class EventNotificationsService {
  private readonly logger = new Logger(EventNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizerMemberAccess: OrganizerMemberAccessService,
    private readonly emailService: EmailService,
  ) {}

  private allowedChannelSet = new Set<string>(EVENT_NOTIFICATION_CHANNEL_VALUES);

  /**
   * MVP: apenas canal `email` (alinhado ao UI atual). Outros valores são validados mas rejeitados até suporte.
   */
  private normalizeChannels(raw: string[]): string[] {
    const uniq = [...new Set(raw.map((c) => c.trim()).filter(Boolean))];
    if (uniq.length === 0) {
      throw new BadRequestException('channels must be a non-empty array');
    }
    for (const c of uniq) {
      if (!this.allowedChannelSet.has(c)) {
        throw new BadRequestException(`Invalid channel: ${c}`);
      }
    }
    if (!uniq.every((c) => c === 'email')) {
      throw new BadRequestException(
        'Only the "email" channel is supported in this version',
      );
    }
    return uniq.sort();
  }

  async list(
    userId: string,
    eventId: string,
    query: ListEventNotificationsQueryDto,
  ) {
    await this.organizerMemberAccess.assertCanAccessEvent(userId, eventId, 'notify');

    const prismaRead = this.prisma.getReadClient();
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 8, 50);
    const where: {
      eventId: string;
      status?: string;
      title?: { contains: string; mode: 'insensitive' };
    } = { eventId };
    if (query.status) {
      where.status = query.status;
    }
    const q = query.q?.trim();
    if (q) {
      where.title = { contains: q, mode: 'insensitive' };
    }

    const en = eventNotifications(prismaRead);
    const [rows, total] = await Promise.all([
      en.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { occurredAt: 'desc' },
        select: {
          id: true,
          occurredAt: true,
          title: true,
          channels: true,
          status: true,
        },
      }),
      en.count({ where }),
    ]);

    return {
      message: 'Notifications fetched successfully',
      data: {
        items: rows.map((r) => ({
          id: r.id,
          occurredAt: r.occurredAt,
          title: r.title,
          channels: r.channels,
          status: r.status,
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 0,
        },
      },
    };
  }

  async getOne(userId: string, eventId: string, notificationId: string) {
    await this.organizerMemberAccess.assertCanAccessEvent(userId, eventId, 'notify');

    const prismaRead = this.prisma.getReadClient();
    const row = await eventNotifications(prismaRead).findFirst({
      where: { id: notificationId, eventId },
      select: {
        id: true,
        occurredAt: true,
        title: true,
        channels: true,
        status: true,
        messageHtml: true,
      },
    });
    if (!row) {
      throw new NotFoundException('Notification not found');
    }
    return {
      message: 'Notification fetched successfully',
      data: {
        id: row.id,
        occurredAt: row.occurredAt,
        title: row.title,
        channels: row.channels,
        status: row.status,
        messageHtml: row.messageHtml,
      },
    };
  }

  async create(userId: string, eventId: string, dto: CreateEventNotificationDto) {
    await this.organizerMemberAccess.assertCanAccessEvent(userId, eventId, 'notify');

    const title = dto.title?.trim() ?? '';
    if (!title.length || title.length > TITLE_MAX) {
      throw new BadRequestException(`title must be between 1 and ${TITLE_MAX} characters`);
    }    

    
    if (dto.messageHtml?.length > MESSAGE_MAX_BYTES) {
      throw new BadRequestException(`messageHtml exceeds maximum size (${MESSAGE_MAX_BYTES} bytes)`);
    }

    const sanitized = sanitizeEventNotificationHtml(dto.messageHtml ?? '');
    if (!plainTextFromHtml(sanitized).length) {
      throw new BadRequestException('messageHtml is empty after sanitization');
    }

    const channels = this.normalizeChannels(dto.channels);

    const prismaWrite = this.prisma.getWriteClient();
    const created = await eventNotifications(prismaWrite).create({
      data: {
        eventId,
        title,
        messageHtml: sanitized,
        channels,
        status: 'sent',
        createdById: userId,
      },
      select: {
        id: true,
        occurredAt: true,
        title: true,
        channels: true,
        status: true,
      },
    });

    // Disparo fire-and-forget: envia emails para todos os inscritos confirmados
    this.dispatchEmailsAsync(eventId, title, sanitized).catch((err) =>
      this.logger.warn(`Falha no disparo assíncrono de comunicado (eventId=${eventId}): ${err?.message ?? err}`),
    );

    return {
      message: 'Notificação registrada.',
      data: {
        id: created.id,
        occurredAt: created.occurredAt,
        title: created.title,
        channels: created.channels,
        status: created.status,
      },
    };
  }

  /**
   * Busca dados do evento/organização e envia o comunicado sequencialmente
   * para todos os participantes com inscrição confirmada.
   * Execução assíncrona — não bloqueia o retorno da API.
   */
  private async dispatchEmailsAsync(
    eventId: string,
    subject: string,
    messageHtml: string,
  ): Promise<void> {
    const prismaRead = this.prisma.getReadClient();

    // Busca evento com dados da organização
    const event = await prismaRead.event.findUnique({
      where: { id: eventId },
      include: { organization: true },
    });

    if (!event) {
      this.logger.warn(`dispatchEmailsAsync: evento não encontrado (id=${eventId})`);
      return;
    }

    const org = event.organization as {
      name: string;
      tradeName?: string | null;
      logoUrl?: string | null;
      instagram?: string | null;
      facebook?: string | null;
      youtube?: string | null;
      tiktok?: string | null;
      website?: string | null;
    } | null;

    const orgName = org?.tradeName || org?.name || 'Organizador';

    // Busca todas as inscrições confirmadas com email do participante/usuário
    const registrations = await prismaRead.registration.findMany({
      where: { eventId, status: 'CONFIRMED' },
      select: {
        participantEmail: true,
        participantName: true,
        user: { select: { email: true, firstName: true } },
      },
    });

    // Coleta destinatários únicos por email
    const seen = new Set<string>();
    const recipients: { email: string; name: string }[] = [];
    for (const reg of registrations) {
      const email = reg.participantEmail ?? reg.user?.email;
      if (!email || seen.has(email)) continue;
      seen.add(email);
      recipients.push({
        email,
        name: reg.participantName ?? reg.user?.firstName ?? 'Participante',
      });
    }

    this.logger.log(`Comunicado "${subject}" — enviando para ${recipients.length} destinatário(s) (eventId=${eventId})`);

    // Envio sequencial para evitar sobrecarga e respeitar regra do projeto
    for (const recipient of recipients) {
      await this.emailService
        .sendOrganizerCommunication({
          recipientEmail: recipient.email,
          firstName: recipient.name,
          eventName: event.name,
          orgName,
          orgAvatarUrl: org?.logoUrl ?? undefined,
          subject,
          messageHtml,
          instagram: org?.instagram ?? undefined,
          facebook: org?.facebook ?? undefined,
          youtube: org?.youtube ?? undefined,
          tiktok: org?.tiktok ?? undefined,
          website: org?.website ?? undefined,
        })
        .catch((err) =>
          this.logger.warn(`Falha ao enviar comunicado para ${recipient.email}: ${err?.message ?? err}`),
        );
    }

    this.logger.log(`Comunicado enviado com sucesso para ${recipients.length} destinatário(s) (eventId=${eventId})`);
  }
}
