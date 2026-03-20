import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OrganizerMemberAccessService } from '../organizations/organizer-member-access.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizerMemberAccess: OrganizerMemberAccessService,
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
        status: 'review',
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
}
