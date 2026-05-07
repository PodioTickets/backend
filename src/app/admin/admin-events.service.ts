import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventStatus, Prisma } from '@prisma/client';

export interface AdminEventsQuery {
  page: number;
  limit: number;
  search?: string;
  status?: EventStatus;
  organizationId?: string;
  city?: string;
  state?: string;
  country?: string;
  eventDateFrom?: Date;
  eventDateTo?: Date;
  createdFrom?: Date;
  createdTo?: Date;
  hasAudit?: boolean;
  sortBy?: 'eventDate' | 'createdAt' | 'name' | 'registrations' | 'revenue';
  sortOrder?: 'asc' | 'desc';
}

@Injectable()
export class AdminEventsService {
  private readonly logger = new Logger(AdminEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getEvents(query: AdminEventsQuery) {
    const {
      page,
      limit,
      search,
      status,
      organizationId,
      city,
      state,
      country,
      eventDateFrom,
      eventDateTo,
      createdFrom,
      createdTo,
      hasAudit,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = query;

    const prismaRead = this.prisma.getReadClient();
    const skip = (page - 1) * limit;

    const where: Prisma.EventWhereInput = {};

    if (status) where.status = status;
    if (organizationId) where.organizationId = organizationId;
    if (city) where.city = { contains: city, mode: 'insensitive' };
    if (state) where.state = { contains: state, mode: 'insensitive' };
    if (country) where.country = { contains: country, mode: 'insensitive' };
    if (hasAudit !== undefined) where.audit = hasAudit ? { isNot: null } : { is: null };

    if (eventDateFrom || eventDateTo) {
      where.eventDate = {};
      if (eventDateFrom) where.eventDate.gte = eventDateFrom;
      if (eventDateTo) where.eventDate.lte = eventDateTo;
    }

    if (createdFrom || createdTo) {
      where.createdAt = {};
      if (createdFrom) where.createdAt.gte = createdFrom;
      if (createdTo) where.createdAt.lte = createdTo;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { city: { contains: search, mode: 'insensitive' } },
        { organization: { name: { contains: search, mode: 'insensitive' } } },
        { organization: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    // Sorting by relation aggregates requires raw ordering — use simple fields via orderBy
    const simpleSort = sortBy === 'registrations' || sortBy === 'revenue'
      ? { createdAt: sortOrder as Prisma.SortOrder }
      : sortBy === 'name'
        ? { name: sortOrder as Prisma.SortOrder }
        : sortBy === 'eventDate'
          ? { eventDate: sortOrder as Prisma.SortOrder }
          : { createdAt: sortOrder as Prisma.SortOrder };

    const [events, total] = await Promise.all([
      prismaRead.event.findMany({
        where,
        orderBy: simpleSort,
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          bannerUrl: true,
          status: true,
          city: true,
          state: true,
          country: true,
          location: true,
          eventDate: true,
          registrationStartDate: true,
          registrationEndDate: true,
          organizerFeeRate: true,
          retentionRate: true,
          createdAt: true,
          updatedAt: true,
          organization: {
            select: {
              id: true,
              name: true,
              tradeName: true,
              email: true,
              logoUrl: true,
              document: true,
              phone: true,
              pix: true,
            },
          },
          audit: { select: { id: true, createdAt: true, retentionReleased: true } },
          _count: {
            select: {
              registrations: true,
              orders: true,
              tickets: true,
              withdrawals: true,
            },
          },
        },
      }),
      prismaRead.event.count({ where }),
    ]);

    const eventIds = events.map((e) => e.id);

    // groupBy does not support relation filters — use raw SQL for both aggregates
    const [revenueRows, confirmedRows] = await Promise.all([
      prismaRead.$queryRaw<{ eventId: string; revenue: bigint }[]>(
        Prisma.sql`
          SELECT o."eventId", COALESCE(SUM(o."finalAmount"), 0)::bigint AS revenue
          FROM "Order" o
          INNER JOIN "Payment" p ON p."orderId" = o.id
          WHERE o."eventId" = ANY(${eventIds}::uuid[])
            AND p.status = 'PAID'
          GROUP BY o."eventId"
        `,
      ),
      prismaRead.$queryRaw<{ eventId: string; confirmed: bigint }[]>(
        Prisma.sql`
          SELECT "eventId", COUNT(id)::bigint AS confirmed
          FROM "Registration"
          WHERE "eventId" = ANY(${eventIds}::uuid[])
            AND status IN ('CONFIRMED', 'COMPLETED')
          GROUP BY "eventId"
        `,
      ),
    ]);

    const revenueByEvent = new Map(
      revenueRows.map((r) => [r.eventId, Number(r.revenue)]),
    );
    const confirmedByEvent = new Map(
      confirmedRows.map((r) => [r.eventId, Number(r.confirmed)]),
    );

    const data = events.map((event) => ({
      ...event,
      revenue: revenueByEvent.get(event.id) ?? 0,
      confirmedRegistrations: confirmedByEvent.get(event.id) ?? 0,
    }));

    // Apply in-memory sort for aggregate fields (registrations/revenue) after enrichment
    if (sortBy === 'registrations') {
      data.sort((a, b) =>
        sortOrder === 'asc'
          ? a.confirmedRegistrations - b.confirmedRegistrations
          : b.confirmedRegistrations - a.confirmedRegistrations,
      );
    } else if (sortBy === 'revenue') {
      data.sort((a, b) =>
        sortOrder === 'asc' ? a.revenue - b.revenue : b.revenue - a.revenue,
      );
    }

    return {
      message: 'Events fetched successfully',
      data: {
        events: data,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    };
  }

  async getRevisionEvents(page: number, limit: number, search?: string, organizationId?: string) {
    const prismaRead = this.prisma.getReadClient();
    const skip = (page - 1) * limit;

    const where: Prisma.EventWhereInput = { status: EventStatus.REVISION };

    if (organizationId) where.organizationId = organizationId;

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { city: { contains: search, mode: 'insensitive' } },
        { organization: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [events, total] = await Promise.all([
      prismaRead.event.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          bannerUrl: true,
          status: true,
          city: true,
          state: true,
          country: true,
          location: true,
          eventDate: true,
          registrationStartDate: true,
          registrationEndDate: true,
          organizerFeeRate: true,
          retentionRate: true,
          createdAt: true,
          updatedAt: true,
          organization: {
            select: {
              id: true,
              name: true,
              tradeName: true,
              email: true,
              logoUrl: true,
              document: true,
              phone: true,
            },
          },
          _count: { select: { registrations: true, tickets: true } },
        },
      }),
      prismaRead.event.count({ where }),
    ]);

    return {
      message: 'Revision events fetched successfully',
      data: {
        events,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    };
  }

  async approveEvent(adminUserId: string, eventId: string) {
    const prismaWrite = this.prisma.getWriteClient();

    const event = await prismaWrite.event.findUnique({
      where: { id: eventId },
      select: { id: true, name: true, status: true },
    });

    if (!event) throw new NotFoundException('Event not found');
    if (event.status !== EventStatus.REVISION) {
      throw new BadRequestException('Only REVISION events can be published by admin');
    }

    const updatedEvent = await prismaWrite.event.update({
      where: { id: eventId },
      data: {
        status: EventStatus.PUBLISHED,
        financialSettingsLockedAt: new Date(),
      },
      select: { id: true, name: true, status: true, financialSettingsLockedAt: true, updatedAt: true },
    });

    this.logger.log(`Admin ${adminUserId} approved event ${eventId} (${event.name}) — status REVISION → PUBLISHED`);

    return {
      message: 'Event approved and published successfully',
      data: { event: updatedEvent },
    };
  }
}
