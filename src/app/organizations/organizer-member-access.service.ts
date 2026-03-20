import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  effectivePermissionsForMember,
  type OrganizerPermissionKey,
} from './constants/organizer-permissions';
import type { OrganizationMemberRole } from '@prisma/client';
import type { Prisma } from '@prisma/client';

export type OrganizerMemberWithAccess = {
  id: string;
  organizationId: string;
  userId: string;
  role: OrganizationMemberRole;
  permissions: Prisma.JsonValue | null;
  eventAccesses: { eventId: string }[];
};

@Injectable()
export class OrganizerMemberAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Primeiro vínculo do usuário com uma organização (painel organizador).
   */
  async getMemberForOrganizerUser(userId: string): Promise<OrganizerMemberWithAccess> {
    const prismaRead = this.prisma.getReadClient();
    const member = await prismaRead.organizationMember.findFirst({
      where: { userId },
      include: {
        eventAccesses: { select: { eventId: true } },
      },
    });
    if (!member) {
      throw new BadRequestException('User is not an organizer');
    }
    return member;
  }

  /**
   * Filtro de eventos no painel: owner vê a org inteira; colaborador sem linhas em eventAccesses vê todos os eventos da org;
   * com linhas, apenas os IDs listados.
   */
  buildOrganizerEventsWhere(member: OrganizerMemberWithAccess): { organizationId: string; id?: { in: string[] } } {
    const base: { organizationId: string; id?: { in: string[] } } = {
      organizationId: member.organizationId,
    };
    if (member.role === 'OWNER') {
      return base;
    }
    if (member.eventAccesses.length === 0) {
      return base;
    }
    return {
      ...base,
      id: { in: member.eventAccesses.map((e) => e.eventId) },
    };
  }

  private effectivePermission(
    member: OrganizerMemberWithAccess,
    key: OrganizerPermissionKey,
  ): boolean {
    const map = effectivePermissionsForMember({
      role: member.role,
      permissionsJson: member.permissions,
    });
    return map[key] === true;
  }

  private eventInScope(member: OrganizerMemberWithAccess, eventId: string): boolean {
    if (member.role === 'OWNER') {
      return true;
    }
    if (member.eventAccesses.length === 0) {
      return true;
    }
    return member.eventAccesses.some((e) => e.eventId === eventId);
  }

  /**
   * Verifica membro da org do evento, escopo de evento e permissão granular (owner ignora permissões armazenadas).
   */
  async assertCanAccessEvent(
    userId: string,
    eventId: string,
    requiredPermission: OrganizerPermissionKey,
  ): Promise<void> {
    const prismaWrite = this.prisma.getWriteClient();

    const event = await prismaWrite.event.findUnique({
      where: { id: eventId },
      select: { id: true, organizationId: true },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const member = await prismaWrite.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: event.organizationId,
          userId,
        },
      },
      include: { eventAccesses: { select: { eventId: true } } },
    });

    if (!member || (member.role !== 'OWNER' && member.role !== 'EMPLOYEE')) {
      throw new BadRequestException(
        'Only organization members (OWNER or EMPLOYEE) can perform this action',
      );
    }

    const asAccess: OrganizerMemberWithAccess = member;

    if (!this.eventInScope(asAccess, eventId)) {
      throw new ForbiddenException('No access to this event');
    }

    if (!this.effectivePermission(asAccess, requiredPermission)) {
      throw new ForbiddenException(`Missing permission: ${requiredPermission}`);
    }
  }
}
