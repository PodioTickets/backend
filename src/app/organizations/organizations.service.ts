import { Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateOrganizationDto,
  AddMemberDto,
  UpdateMemberRoleDto,
  UpdateOrganizationDto,
  PutMemberPermissionsDto,
  PutMemberEventsDto,
  PatchMemberSettingsDto,
  OrganizationAuditLogQueryDto,
  AdminAuditLogQueryDto,
  AdminOrganizationsListQueryDto,
} from './dto/organization.dto';
import { OrganizationMemberRole } from '@prisma/client';
import { MFAService } from '../../common/services/mfa.service';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import {
  DEFAULT_NEW_MEMBER_PERMISSIONS,
  effectivePermissionsForMember,
  FULL_ORGANIZER_PERMISSIONS,
  grantedPermissionKeys,
  mapFromPermissionKeys,
  UnknownOrganizerPermissionKeyError,
  type OrganizerPermissionsMap,
} from './constants/organizer-permissions';
import { resolveOrganizerPageViewActionLabel } from './organizer-audit-page-label.util';
import { formatAuditLogItemForResponse } from './audit-log-item-format.util';
import { buildAuditChangeDetails } from './audit-log-change-details.util';
import { EmailService } from '../../common/services/email.service';

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mfaService: MFAService,
    private readonly emailService: EmailService,
  ) {}

  private mapFromKeysOrThrow(keys: string[]): OrganizerPermissionsMap {
    try {
      return mapFromPermissionKeys(keys);
    } catch (e) {
      if (e instanceof UnknownOrganizerPermissionKeyError) {
        throw new BadRequestException(`Unknown permission key: "${e.raw}"`);
      }
      throw e;
    }
  }

  private normalizeNewMemberPermissions(
    input?: string[] | null,
  ): OrganizerPermissionsMap {
    if (input == null) {
      return { ...DEFAULT_NEW_MEMBER_PERMISSIONS };
    }
    return this.mapFromKeysOrThrow(input);
  }

  private normalizePutPermissions(keys: string[]): OrganizerPermissionsMap {
    return this.mapFromKeysOrThrow(keys);
  }

  private async assertEventsBelongToOrganization(
    organizationId: string,
    eventIds: string[],
  ) {
    if (eventIds.length === 0) return;
    const prismaRead = this.prisma.getReadClient();
    const count = await prismaRead.event.count({
      where: { organizationId, id: { in: eventIds } },
    });
    if (count !== eventIds.length) {
      throw new BadRequestException(
        'One or more events are invalid or belong to another organization',
      );
    }
  }

  /** Garante JSON serializável (datas, etc.) e, em `changes`, old/new + valorAnterior/valorNovo. */
  private serializeAuditValue(value: unknown): unknown {
    if (value === undefined) return null;
    if (value === null) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) {
      return value.map((v) => this.serializeAuditValue(v));
    }
    if (typeof value === 'object') {
      const o = value as Record<string, unknown> & { toJSON?: () => unknown };
      if (typeof o.toJSON === 'function') {
        return this.serializeAuditValue(o.toJSON());
      }
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) {
        out[k] = this.serializeAuditValue(val);
      }
      return out;
    }
    return value;
  }

  private prepareAuditMetadata(meta: Prisma.InputJsonValue): Prisma.InputJsonValue {
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
      return this.serializeAuditValue(meta) as Prisma.InputJsonValue;
    }
    const base = meta as Record<string, unknown>;
    const out: Record<string, unknown> = { ...base };
    if (Array.isArray(out.changes)) {
      out.changes = out.changes.map((entry: unknown) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return this.serializeAuditValue(entry);
        }
        const e = entry as Record<string, unknown>;
        const oldS = this.serializeAuditValue(e.old);
        const newS = this.serializeAuditValue(e.new);
        const row: Record<string, unknown> = {
          field: e.field,
          old: oldS,
          new: newS,
          valorAnterior: oldS,
          valorNovo: newS,
        };
        if ('label' in e && e.label !== undefined) {
          row.label = this.serializeAuditValue(e.label);
        }
        return row;
      });
    }
    for (const key of Object.keys(out)) {
      if (key === 'changes') continue;
      out[key] = this.serializeAuditValue(out[key]);
    }
    return out as Prisma.InputJsonValue;
  }

  async recordOrganizationAuditLog(params: {
    organizationId: string;
    actorUserId: string | null;
    ip?: string | null;
    action: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    const prismaWrite = this.prisma.getWriteClient();
    await prismaWrite.organizationAuditLog.create({
      data: {
        organizationId: params.organizationId,
        actorUserId: params.actorUserId,
        ip: params.ip ?? null,
        action: params.action,
        metadata:
          params.metadata === undefined
            ? Prisma.JsonNull
            : this.prepareAuditMetadata(params.metadata),
      },
    });
  }

  /** Janela em que F5 na mesma página não gera novo log (por org + usuário + pageKey). */
  private static readonly ORGANIZER_PAGE_VIEW_DEDUPE_MS = 30 * 60 * 1000;

  /**
   * Registra acesso a uma rota do painel (com deduplicação).
   * Qualquer membro da organização pode enviar; apenas quem pertence a uma org grava log.
   */
  async recordOrganizerPageView(
    userId: string,
    pageKey: string,
    clientIp?: string | null,
  ) {
    const trimmed = pageKey?.trim();
    if (!trimmed) {
      throw new BadRequestException('pageKey is required');
    }
    const prismaRead = this.prisma.getReadClient();
    const prismaWrite = this.prisma.getWriteClient();

    // Combina member-lookup + dedup-lookup numa única round-trip ao Postgres.
    // O caminho comum (mesmo usuário re-renderiza a página dentro da janela de 30min)
    // antes fazia 2 queries serializadas; agora faz 1 e retorna early.
    type MemberDedupeRow = {
      organizationId: string;
      lastRecordedAt: Date | null;
    };
    const rows = await prismaRead.$queryRaw<MemberDedupeRow[]>`
      SELECT
        m."organizationId" AS "organizationId",
        d."lastRecordedAt" AS "lastRecordedAt"
      FROM "OrganizationMember" m
      LEFT JOIN "OrganizerAuditPageDedupe" d
        ON d."organizationId" = m."organizationId"
       AND d."actorUserId"    = m."userId"
       AND d."pageKey"        = ${trimmed}
      WHERE m."userId" = ${userId}::uuid
      LIMIT 1
    `;

    const memberRow = rows[0];
    if (!memberRow) {
      throw new ForbiddenException('Not an organization member');
    }
    const organizationId = memberRow.organizationId;
    const now = new Date();

    if (
      memberRow.lastRecordedAt &&
      now.getTime() - new Date(memberRow.lastRecordedAt).getTime() <
        OrganizationsService.ORGANIZER_PAGE_VIEW_DEDUPE_MS
    ) {
      return {
        message: 'Page view omitted (deduplicated)',
        data: { recorded: false, pageKey: trimmed },
      };
    }
    const actionLabel = await resolveOrganizerPageViewActionLabel(
      prismaRead,
      organizationId,
      trimmed,
    );

    await prismaWrite.$transaction(async (tx) => {
      await tx.organizationAuditLog.create({
        data: {
          organizationId,
          actorUserId: userId,
          ip: clientIp ?? null,
          action: actionLabel,
          metadata: {
            kind: 'PAGE_VIEW',
            page: trimmed,
          },
        },
      });
      await tx.organizerAuditPageDedupe.upsert({
        where: {
          organizationId_actorUserId_pageKey: {
            organizationId,
            actorUserId: userId,
            pageKey: trimmed,
          },
        },
        create: {
          organizationId,
          actorUserId: userId,
          pageKey: trimmed,
          lastRecordedAt: now,
        },
        update: { lastRecordedAt: now },
      });
    });
    return {
      message: 'Page view recorded',
      data: { recorded: true, pageKey: trimmed },
    };
  }

  private async replaceMemberEventAccess(
    organizationMemberId: string,
    organizationId: string,
    eventIds: string[],
  ) {
    await this.assertEventsBelongToOrganization(organizationId, eventIds);
    const prismaWrite = this.prisma.getWriteClient();
    await prismaWrite.$transaction(async (tx: any) => {
      await tx.organizationMember.update({
        where: { id: organizationMemberId },
        data: { restrictedToEvents: true },
      });
      await tx.organizationMemberEventAccess.deleteMany({
        where: { organizationMemberId },
      });
      if (eventIds.length > 0) {
        await tx.organizationMemberEventAccess.createMany({
          data: eventIds.map((eventId) => ({
            organizationMemberId,
            eventId,
          })),
        });
      }
    });
  }

  private async resolveMemberEventIdsForApi(params: {
    role: OrganizationMemberRole;
    organizationId: string;
    eventAccesses: { eventId: string }[];
    restrictedToEvents?: boolean;
  }): Promise<string[]> {
    const prismaRead = this.prisma.getReadClient();
    const allInOrg = async () => {
      const rows = await prismaRead.event.findMany({
        where: { organizationId: params.organizationId },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    };
    if (params.role === 'OWNER') {
      return allInOrg();
    }
    // Sem restrição explícita e sem eventos cadastrados → acesso irrestrito (legado)
    if (!params.restrictedToEvents && params.eventAccesses.length === 0) {
      return allInOrg();
    }
    return params.eventAccesses.map((e) => e.eventId);
  }

  private mapMemberForListResponse(
    m: {
      id: string;
      organizationId: string;
      userId: string;
      role: OrganizationMemberRole;
      permissions: Prisma.JsonValue | null;
      createdAt: Date;
      updatedAt: Date;
      user: {
        id: string;
        firstName: string;
        lastName: string;
        email: string;
        phone: string | null;
        lastLoginAt: Date | null;
      };
      eventAccesses: { eventId: string }[];
    },
    eventIdsResolved: string[],
  ) {
    return {
      id: m.id,
      organizationId: m.organizationId,
      userId: m.userId,
      role: m.role,
      permissions: grantedPermissionKeys(
        effectivePermissionsForMember({
          role: m.role,
          permissionsJson: m.permissions,
        }),
      ),
      eventIds: eventIdsResolved,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      user: m.user,
    };
  }

  private formatMemberNameForAudit(params: {
    firstName?: string | null;
    lastName?: string | null;
    userId: string;
  }): string {
    const fullName = `${params.firstName ?? ''} ${params.lastName ?? ''}`.trim();
    return fullName.length > 0 ? fullName : params.userId;
  }

  /**
   * Limpa o documentNumber removendo formatação
   */
  private cleanDocumentNumber(documentNumber?: string | null): string | null {
    if (!documentNumber) return null;
    return documentNumber.replace(/\D/g, '');
  }

  /**
   * Cria uma organização.
   *
   * Owner é opcional:
   *   - `userId` fornecido        → promove usuário existente a OWNER.
   *   - dados de owner fornecidos → cria um novo usuário ORGANIZER e o atribui como OWNER.
   *   - nenhum dos dois           → cria a organização "vazia"; owner pode ser adicionado depois
   *                                 via POST /api/v1/admin/organizations/:id/members.
   */
  async createOrganization(createDto: CreateOrganizationDto) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Detecta se há intenção de criar/vincular owner nesta chamada.
    const hasOwnerEmailData = !!(createDto.ownerEmail || createDto.ownerPassword || createDto.ownerFirstName || createDto.ownerLastName);
    const provisionOwner = !!createDto.userId || hasOwnerEmailData;

    if (provisionOwner) {
      if (!createDto.userId) {
        // Caminho "criar usuário": todos os 4 campos são obrigatórios juntos.
        if (!createDto.ownerEmail || !createDto.ownerPassword || !createDto.ownerFirstName || !createDto.ownerLastName) {
          throw new BadRequestException(
            'Para criar um novo owner, forneça email, password, firstName e lastName. ' +
            'Para promover um usuário existente, forneça userId. ' +
            'Para criar a organização sem owner, omita todos esses campos.',
          );
        }

        // Verificar se email já existe (conta ORGANIZER)
        const existingUserByEmail = await prismaRead.user.findUnique({
          where: {
            email_accountType: {
              email: createDto.ownerEmail,
              accountType: 'ORGANIZER',
            },
          },
        });

        if (existingUserByEmail) {
          throw new ConflictException('User with this email already exists');
        }

        // Verificar se CPF já existe (se fornecido)
        if (createDto.ownerDocumentNumber) {
          const documentNumberClean = this.cleanDocumentNumber(createDto.ownerDocumentNumber);
          if (documentNumberClean) {
            const existingUserByCpf = await prismaRead.user.findUnique({
              where: {
                documentNumberClean_accountType: {
                  documentNumberClean,
                  accountType: 'ORGANIZER',
                },
              },
            });

            if (existingUserByCpf) {
              throw new ConflictException('User with this document number already exists');
            }
          }
        }
      } else {
        // Caminho "promover usuário existente"
        const user = await prismaRead.user.findUnique({
          where: { id: createDto.userId },
        });

        if (!user) {
          throw new NotFoundException('User not found');
        }

        const existingMember = await prismaRead.organizationMember.findFirst({
          where: {
            userId: createDto.userId,
            role: 'OWNER',
          },
        });

        if (existingMember) {
          throw new BadRequestException('User is already an owner of an organization');
        }
      }
    }

    // Criar organização (e opcionalmente usuário + membro OWNER) em uma transação
    const result = await prismaWrite.$transaction(async (tx) => {
      let userId: string | null = null;

      if (provisionOwner) {
        if (!createDto.userId) {
          const hashedPassword = await bcrypt.hash(createDto.ownerPassword!, 12);
          const documentNumberClean = createDto.ownerDocumentNumber
            ? this.cleanDocumentNumber(createDto.ownerDocumentNumber)
            : null;

          const newUser = await tx.user.create({
            data: {
              email: createDto.ownerEmail!,
              accountType: 'ORGANIZER',
              password: hashedPassword,
              firstName: createDto.ownerFirstName!,
              lastName: createDto.ownerLastName!,
              phone: createDto.ownerPhone,
              documentNumber: createDto.ownerDocumentNumber,
              documentNumberClean,
            },
          });

          userId = newUser.id;
        } else {
          userId = createDto.userId;

          // Re-check dentro da transação (defende contra race condition).
          const existingMember = await tx.organizationMember.findFirst({
            where: { userId, role: 'OWNER' },
          });

          if (existingMember) {
            throw new BadRequestException('User is already an owner of an organization');
          }
        }
      }

      // Criar a organização
      const organization = await tx.organization.create({
        data: {
          name: createDto.name,
          tradeName: createDto.tradeName,
          document: createDto.document,
          logoUrl: createDto.logoUrl,
          email: createDto.email,
          fiscalEmail: createDto.fiscalEmail,
          phone: createDto.phone,
          whatsapp: createDto.whatsapp,
          siteUrl: createDto.siteUrl,
          instagram: createDto.instagram,
          description: createDto.description,
          zipCode: createDto.zipCode,
          street: createDto.street,
          number: createDto.number,
          neighborhood: createDto.neighborhood,
          city: createDto.city,
          state: createDto.state,
          ownerName: createDto.ownerName,
          ownerDocument: createDto.ownerDocument,
          bankName: createDto.bankName,
          bankCode: createDto.bankCode,
          agency: createDto.agency,
          account: createDto.account,
          accountType: createDto.accountType,
          accountHolderName: createDto.accountHolderName,
          accountHolderDocument: createDto.accountHolderDocument,
        },
      });

      let member: any = null;
      if (userId) {
        member = await tx.organizationMember.create({
          data: {
            organizationId: organization.id,
            userId,
            role: 'OWNER',
          },
          include: {
            user: {
              select: { id: true, firstName: true, lastName: true, email: true, phone: true },
            },
            organization: true,
          },
        });

        await tx.user.update({
          where: { id: userId },
          data: { role: 'ORGANIZER', accountType: 'ORGANIZER' },
        });
      }

      // Criar chaves PIX iniciais, se enviadas. Mesma semântica do update:
      // se nenhuma vier marcada como default, a primeira é promovida.
      const incomingPixKeys = createDto.pixKeys ?? [];
      if (incomingPixKeys.length > 0) {
        const hasDefault = incomingPixKeys.some((k) => k.isDefault);
        await tx.organizationPixKey.createMany({
          data: incomingPixKeys.map((k, i) => ({
            organizationId: organization.id,
            key: k.key,
            keyType: k.keyType,
            isDefault: hasDefault ? !!k.isDefault : i === 0,
            bankName: k.bankName ?? null,
            accountHolderName: k.accountHolderName ?? null,
            accountHolderDocument: k.accountHolderDocument ?? null,
          })),
        });
      }

      return { organization, member };
    });

    // Notifica o novo organizador por e-mail apenas se um member foi criado.
    if (result.member) {
      // Boas-vindas vai pro e-mail de CONTATO da organização (fallback: e-mail do dono se o contato vier vazio).
      const recipientEmail = result.organization.email || result.member.user.email;
      const ownerFirstName = result.member.user.firstName;
      this.emailService
        .sendWelcomeOrganizer({ email: recipientEmail, firstName: ownerFirstName })
        .catch((err) =>
          this.logger.warn(
            `Falha ao enviar e-mail de boas-vindas ao organizador (org=${result.organization.id}): ${err?.message ?? err}`,
          ),
        );
    }

    // Carrega as chaves PIX recém-criadas para incluir no payload de resposta (paridade com PATCH).
    const pixKeys = await this.prisma.getReadClient().organizationPixKey.findMany({
      where: { organizationId: result.organization.id },
      select: {
        id: true,
        key: true,
        keyType: true,
        isDefault: true,
        bankName: true,
        accountHolderName: true,
        accountHolderDocument: true,
        createdAt: true,
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });

    return {
      message: 'Organization created successfully',
      data: {
        organization: { ...result.organization, pixKeys },
        member: result.member,
      },
    };
  }

  /**
   * Verifica se o usuário é dono da organização
   */
  async isOwner(userId: string, organizationId: string): Promise<boolean> {
    const prismaRead = this.prisma.getReadClient();
    
    const member = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId,
        },
      },
    });

    return member?.role === 'OWNER';
  }

  /**
   * Verifica se o usuário é membro da organização (dono ou funcionário)
   */
  async isMember(userId: string, organizationId: string): Promise<boolean> {
    const prismaRead = this.prisma.getReadClient();
    
    const member = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId,
        },
      },
    });

    return !!member;
  }

  /**
   * Obtém a organização do organizador
   */
  async getOrganizationByOrganizer(userId: string) {
    const prismaRead = this.prisma.getReadClient();

    const member = await prismaRead.organizationMember.findFirst({
      where: {
        userId,
        // Aceita qualquer role: OWNER, ADMIN, MEMBER, etc.
      },
      include: {
        organization: {
          include: {
            members: {
              include: {
                user: {
                  select: {
                    id: true,
                    email: true,
                    firstName: true,
                    lastName: true,
                    gender: true,
                    phone: true,
                    reservePhone: true,
                    dateOfBirth: true,
                    country: true,
                    state: true,
                    city: true,
                    documentType: true,
                    documentNumber: true,
                    genderDetails: true,
                    language: true,
                    role: true,
                    avatarUrl: true,
                    createdAt: true,
                    updatedAt: true,
                  },
                },
              },
            },
            pixKeys: {
              select: {
                id: true,
                key: true,
                keyType: true,
                isDefault: true,
                bankName: true,
                accountHolderName: true,
                accountHolderDocument: true,
                createdAt: true,
              },
              orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
            },
          },
        },
      },
    });

    if (!member) {
      throw new NotFoundException('Organizer not found');
    }

    const permMap = effectivePermissionsForMember({
      role: member.role,
      permissionsJson: member.permissions,
    });

    return {
      message: 'Organization fetched successfully',
      data: {
        organization: member.organization,
        member: {
          role: member.role,
          permissions: grantedPermissionKeys(permMap),
        },
      },
    };
  }

  /**
   * Atualiza informações da organização (apenas dono)
   */
  async updateOrganization(userId: string, organizationId: string, updateDto: UpdateOrganizationDto) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Verificar se o usuário é dono
    const isOwner = await this.isOwner(userId, organizationId);
    if (!isOwner) {
      throw new ForbiddenException('Only organization owner can update organization');
    }

    const organization = await prismaWrite.organization.update({
      where: { id: organizationId },
      data: updateDto,
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                gender: true,
                phone: true,
                reservePhone: true,
                dateOfBirth: true,
                country: true,
                state: true,
                city: true,
                documentType: true,
                documentNumber: true,
                genderDetails: true,
                language: true,
                role: true,
                avatarUrl: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        },
      },
    });

    return {
      message: 'Organization updated successfully',
      data: { organization },
    };
  }

  /**
   * Atualiza apenas o logo da organização (apenas dono)
   */
  async updateOrganizationLogo(userId: string, organizationId: string, logoUrl: string) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Verificar se o usuário é dono
    const isOwner = await this.isOwner(userId, organizationId);
    if (!isOwner) {
      throw new ForbiddenException('Only organization owner can update organization logo');
    }

    // Verificar se a organização existe
    const organization = await prismaRead.organization.findUnique({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const updatedOrganization = await prismaWrite.organization.update({
      where: { id: organizationId },
      data: { logoUrl },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                gender: true,
                phone: true,
                reservePhone: true,
                dateOfBirth: true,
                country: true,
                state: true,
                city: true,
                documentType: true,
                documentNumber: true,
                genderDetails: true,
                language: true,
                role: true,
                avatarUrl: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        },
      },
    });

    return {
      message: 'Organization logo updated successfully',
      data: { organization: updatedOrganization },
    };
  }

  /**
   * Adiciona um membro à organização (apenas dono)
   * Se userId não for fornecido, cria um novo usuário com os dados fornecidos
   */
  async addMember(
    userId: string,
    organizationId: string,
    addMemberDto: AddMemberDto,
    clientIp?: string | null,
  ) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Verificar se o usuário é dono
    const isOwner = await this.isOwner(userId, organizationId);
    if (!isOwner) {
      throw new ForbiddenException('Only organization owner can add members');
    }

    let userToAddId: string;

    // Se userId foi fornecido, usar usuário existente
    if (addMemberDto.userId) {
      const userToAdd = await prismaRead.user.findUnique({
        where: { id: addMemberDto.userId },
      });

      if (!userToAdd) {
        throw new NotFoundException('User not found');
      }

      if (userToAdd.accountType !== 'ORGANIZER') {
        throw new BadRequestException('User must have accountType ORGANIZER to be added as organization member');
      }

      userToAddId = addMemberDto.userId;
    } else {
      // Criar novo usuário
      if (!addMemberDto.firstName || !addMemberDto.lastName || !addMemberDto.email || !addMemberDto.password) {
        throw new BadRequestException('firstName, lastName, email and password are required when creating a new user');
      }

      // Verificar se email já existe (conta ORGANIZER)
      const existingUser = await prismaRead.user.findUnique({
        where: {
          email_accountType: {
            email: addMemberDto.email,
            accountType: 'ORGANIZER',
          },
        },
        include: {
          organizationMembers: {
            select: { organizationId: true },
          },
        },
      });

      if (existingUser) {
        const belongsToThisOrg = existingUser.organizationMembers.some(
          (m: any) => m.organizationId === organizationId,
        );
        if (belongsToThisOrg) {
          throw new ConflictException('Esse email já foi cadastrado.');
        }
        throw new ConflictException('Este usuário já está em uma organização.');
      }

      // Hash da senha
      const hashedPassword = await bcrypt.hash(addMemberDto.password, 12);

      // Gerar 2FA se solicitado
      let totpSecret: string | null = null;
      let mfaEnabled = false;
      if (addMemberDto.enable2FA) {
        const mfaResult = await this.mfaService.generateTOTPSecret('temp', addMemberDto.email);
        totpSecret = mfaResult.secret;
        mfaEnabled = true;
      }

      // Criar usuário (conta ORGANIZER)
      const newUser = await prismaWrite.user.create({
        data: {
          firstName: addMemberDto.firstName,
          lastName: addMemberDto.lastName,
          email: addMemberDto.email,
          accountType: 'ORGANIZER', // Conta de organizador
          password: hashedPassword,
          phone: addMemberDto.phone,
          totpSecret,
          mfaEnabled,
        },
      });

      userToAddId = newUser.id;
    }

    // Verificar se o usuário já é membro
    const existingMember = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId: userToAddId,
        },
      },
    });

    if (existingMember) {
      throw new BadRequestException('User is already a member of this organization');
    }

    // Não permitir adicionar outro OWNER
    if (addMemberDto.role === 'OWNER') {
      throw new BadRequestException('Cannot add another owner. Only one owner per organization.');
    }

    const permissionsJson = this.normalizeNewMemberPermissions(
      addMemberDto.permissions,
    ) as Prisma.InputJsonValue;

    if (addMemberDto.eventIds?.length) {
      await this.assertEventsBelongToOrganization(
        organizationId,
        addMemberDto.eventIds,
      );
    }

    const member = await prismaWrite.$transaction(async (tx) => {
      const created = await tx.organizationMember.create({
        data: {
          organizationId,
          userId: userToAddId,
          role: addMemberDto.role,
          permissions: permissionsJson,
        },
      });

      if (addMemberDto.eventIds?.length) {
        await tx.organizationMemberEventAccess.createMany({
          data: addMemberDto.eventIds.map((eventId) => ({
            organizationMemberId: created.id,
            eventId,
          })),
        });
      }

      return tx.organizationMember.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              mfaEnabled: true,
            },
          },
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
          eventAccesses: { select: { eventId: true } },
        },
      });
    });

    await this.recordOrganizationAuditLog({
      organizationId,
      actorUserId: userId,
      ip: clientIp ?? null,
      action: `Adicionou colaborador à equipe (${this.formatMemberNameForAudit({
        firstName: member.user.firstName,
        lastName: member.user.lastName,
        userId: member.userId,
      })})`,
      metadata: {
        kind: 'MEMBER_ADD',
        memberUserId: userToAddId,
        changes: [
          {
            field: 'colaborador',
            old: null,
            new: {
              userId: member.userId,
              email: member.user.email,
              nome: `${member.user.firstName ?? ''} ${member.user.lastName ?? ''}`.trim(),
              role: member.role,
              permissions: member.permissions,
              eventIds: member.eventAccesses.map((a) => a.eventId),
            },
          },
        ],
      },
    });

    // Dispara email de boas-vindas ao novo membro (fire-and-forget)
    const registeredAt = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    }).format(new Date()).replace(',', ' ·');

    this.emailService
      .sendMemberAdded({
        recipientEmail: member.user.email,
        firstName: member.user.firstName ?? member.user.email,
        orgName: member.organization.name,
        registeredAt,
      })
      .catch((err: any) =>
        this.logger.warn(`Falha ao enviar email de boas-vindas ao membro (userId=${member.userId}): ${err?.message ?? err}`),
      );

    return {
      message: 'Member added successfully',
      data: { member },
    };
  }

  /**
   * Remove um membro da organização (apenas dono)
   */
  async removeMember(
    userId: string,
    organizationId: string,
    memberUserId: string,
    clientIp?: string | null,
  ) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Verificar se o usuário é dono
    const isOwner = await this.isOwner(userId, organizationId);
    if (!isOwner) {
      throw new ForbiddenException('Only organization owner can remove members');
    }

    // Não permitir remover o próprio dono
    if (userId === memberUserId) {
      throw new BadRequestException('Cannot remove yourself as owner');
    }

    // Verificar se o membro existe
    const member = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId: memberUserId,
        },
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
        eventAccesses: { select: { eventId: true } },
      },
    });

    if (!member) {
      throw new NotFoundException('Member not found');
    }

    await this.recordOrganizationAuditLog({
      organizationId,
      actorUserId: userId,
      ip: clientIp ?? null,
      action: `Removeu colaborador da equipe (${this.formatMemberNameForAudit({
        firstName: member.user.firstName,
        lastName: member.user.lastName,
        userId: memberUserId,
      })})`,
      metadata: {
        kind: 'MEMBER_REMOVE',
        memberUserId,
        changes: [
          {
            field: 'colaborador',
            old: {
              userId: memberUserId,
              email: member.user.email,
              nome: `${member.user.firstName ?? ''} ${member.user.lastName ?? ''}`.trim(),
              role: member.role,
              permissions: member.permissions,
              eventIds: member.eventAccesses.map((a) => a.eventId),
            },
            new: null,
          },
        ],
      },
    });

    // Remover membro e deletar usuário em uma única transação
    await prismaWrite.$transaction(async (tx: any) => {
      await tx.organizationMember.delete({
        where: {
          organizationId_userId: {
            organizationId,
            userId: memberUserId,
          },
        },
      });

      await tx.user.delete({
        where: { id: memberUserId },
      });
    });

    return {
      message: 'Member removed successfully',
    };
  }

  /**
   * Atualiza o role de um membro (apenas dono)
   */
  async updateMemberRole(
    userId: string,
    organizationId: string,
    memberUserId: string,
    updateDto: UpdateMemberRoleDto,
    clientIp?: string | null,
  ) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Verificar se o usuário é dono
    const isOwner = await this.isOwner(userId, organizationId);
    if (!isOwner) {
      throw new ForbiddenException('Only organization owner can update member roles');
    }

    // Não permitir mudar o próprio role de OWNER
    if (userId === memberUserId && updateDto.role !== 'OWNER') {
      throw new BadRequestException('Cannot change your own role from OWNER');
    }

    // Não permitir criar outro OWNER
    if (updateDto.role === 'OWNER' && userId !== memberUserId) {
      throw new BadRequestException('Cannot assign OWNER role. Only one owner per organization.');
    }

    // Verificar se o membro existe
    const member = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId: memberUserId,
        },
      },
    });

    if (!member) {
      throw new NotFoundException('Member not found');
    }

    if (member.role === updateDto.role) {
      const updatedMember = await prismaRead.organizationMember.findUniqueOrThrow({
        where: {
          organizationId_userId: {
            organizationId,
            userId: memberUserId,
          },
        },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
            },
          },
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });
      return {
        message: 'Member role updated successfully',
        data: { member: updatedMember },
      };
    }

    // Atualizar role
    const updatedMember = await prismaWrite.organizationMember.update({
      where: {
        organizationId_userId: {
          organizationId,
          userId: memberUserId,
        },
      },
      data: {
        role: updateDto.role,
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
        organization: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    await this.recordOrganizationAuditLog({
      organizationId,
      actorUserId: userId,
      ip: clientIp ?? null,
      action: `Alterou papel do colaborador (${this.formatMemberNameForAudit({
        firstName: updatedMember.user.firstName,
        lastName: updatedMember.user.lastName,
        userId: memberUserId,
      })}) para ${updateDto.role}`,
      metadata: {
        kind: 'MEMBER_ROLE',
        page: updateDto.clientPage ?? 'member-role',
        memberUserId,
        fieldsEdited: ['role'],
        changes: [
          { field: 'role', old: member.role, new: updateDto.role },
        ],
      },
    });

    return {
      message: 'Member role updated successfully',
      data: { member: updatedMember },
    };
  }

  /**
   * Lista todos os membros da organização
   */
  async listMembers(userId: string, organizationId: string) {
    const prismaRead = this.prisma.getReadClient();

    // Verificar se o usuário é membro
    const isMember = await this.isMember(userId, organizationId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    const members = await prismaRead.organizationMember.findMany({
      where: { organizationId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            lastLoginAt: true,
          },
        },
        eventAccesses: { select: { eventId: true } },
      },
      orderBy: [
        { role: 'asc' }, // OWNER primeiro
        { createdAt: 'asc' },
      ],
    });

    const mapped = await Promise.all(
      members.map(async (m) => {
        const eventIds = await this.resolveMemberEventIdsForApi({
          role: m.role,
          organizationId: m.organizationId,
          eventAccesses: m.eventAccesses,
          restrictedToEvents: m.restrictedToEvents,
        });
        return this.mapMemberForListResponse(m, eventIds);
      }),
    );

    return {
      message: 'Members fetched successfully',
      data: { members: mapped },
    };
  }

  async getMemberPermissions(
    ownerUserId: string,
    organizationId: string,
    memberUserId: string,
  ) {
    const prismaRead = this.prisma.getReadClient();
    if (!(await this.isOwner(ownerUserId, organizationId))) {
      throw new ForbiddenException('Only organization owner can view member permissions');
    }
    const row = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: memberUserId },
      },
      include: {
        user: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
    });
    if (!row) {
      throw new NotFoundException('Member not found');
    }
    const map =
      row.role === 'OWNER'
        ? { ...FULL_ORGANIZER_PERMISSIONS }
        : effectivePermissionsForMember({
            role: row.role,
            permissionsJson: row.permissions,
          });
    return {
      message: 'Member permissions retrieved successfully',
      data: { memberUserId, permissions: grantedPermissionKeys(map) },
    };
  }

  async putMemberPermissions(
    ownerUserId: string,
    organizationId: string,
    memberUserId: string,
    dto: PutMemberPermissionsDto,
    clientIp?: string | null,
  ) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();
    if (!(await this.isOwner(ownerUserId, organizationId))) {
      throw new ForbiddenException('Only organization owner can update member permissions');
    }
    const row = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: memberUserId },
      },
      include: {
        user: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
    });
    if (!row) {
      throw new NotFoundException('Member not found');
    }
    if (row.role === 'OWNER') {
      return {
        message: 'Member permissions updated successfully',
        data: {
          memberUserId,
          permissions: grantedPermissionKeys({ ...FULL_ORGANIZER_PERMISSIONS }),
        },
      };
    }
    const beforeMap = effectivePermissionsForMember({
      role: row.role,
      permissionsJson: row.permissions,
    });
    const beforeKeys = grantedPermissionKeys(beforeMap).slice().sort();
    const normalized = this.normalizePutPermissions(dto.permissions);
    const afterKeys = grantedPermissionKeys(normalized).slice().sort();
    if (JSON.stringify(beforeKeys) === JSON.stringify(afterKeys)) {
      return {
        message: 'Member permissions updated successfully',
        data: {
          memberUserId,
          permissions: afterKeys,
        },
      };
    }
    await prismaWrite.organizationMember.update({
      where: {
        organizationId_userId: { organizationId, userId: memberUserId },
      },
      data: { permissions: normalized as unknown as Prisma.InputJsonValue },
    });
    await this.recordOrganizationAuditLog({
      organizationId,
      actorUserId: ownerUserId,
      ip: clientIp ?? null,
      action: `Atualizou permissões do colaborador (${this.formatMemberNameForAudit({
        firstName: row.user.firstName,
        lastName: row.user.lastName,
        userId: memberUserId,
      })})`,
      metadata: {
        kind: 'MEMBER_PERMISSIONS',
        page: dto.clientPage ?? 'member-permissions',
        memberUserId,
        fieldsEdited: ['permissions'],
        changes: [
          { field: 'permissions', old: beforeKeys, new: afterKeys },
        ],
        permissionKeys: afterKeys,
      },
    });
    return {
      message: 'Member permissions updated successfully',
      data: {
        memberUserId,
        permissions: grantedPermissionKeys(normalized),
      },
    };
  }

  async getMemberEvents(
    ownerUserId: string,
    organizationId: string,
    memberUserId: string,
  ) {
    const prismaRead = this.prisma.getReadClient();
    if (!(await this.isOwner(ownerUserId, organizationId))) {
      throw new ForbiddenException('Only organization owner can view member event access');
    }
    const row = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: memberUserId },
      },
      include: { eventAccesses: { select: { eventId: true } } },
    });
    if (!row) {
      throw new NotFoundException('Member not found');
    }
    const eventIds = await this.resolveMemberEventIdsForApi({
      role: row.role,
      organizationId,
      eventAccesses: row.eventAccesses,
      restrictedToEvents: row.restrictedToEvents,
    });
    return {
      message: 'Member event access retrieved successfully',
      data: { memberUserId, eventIds },
    };
  }

  async putMemberEvents(
    ownerUserId: string,
    organizationId: string,
    memberUserId: string,
    dto: PutMemberEventsDto,
    clientIp?: string | null,
  ) {
    const prismaRead = this.prisma.getReadClient();
    if (!(await this.isOwner(ownerUserId, organizationId))) {
      throw new ForbiddenException('Only organization owner can update member event access');
    }
    const row = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: memberUserId },
      },
      include: {
        user: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
        eventAccesses: { select: { eventId: true } },
      },
    });
    if (!row) {
      throw new NotFoundException('Member not found');
    }
    if (row.role === 'OWNER') {
      const eventIds = await this.resolveMemberEventIdsForApi({
        role: row.role,
        organizationId,
        eventAccesses: [],
      });
      return {
        message: 'Member event access updated successfully',
        data: { memberUserId, eventIds },
      };
    }
    const beforeEventIds = (
      await this.resolveMemberEventIdsForApi({
        role: row.role,
        organizationId,
        eventAccesses: row.eventAccesses,
        restrictedToEvents: row.restrictedToEvents,
      })
    )
      .slice()
      .sort();
    const afterEventIds = dto.eventIds.slice().sort();
    if (JSON.stringify(beforeEventIds) === JSON.stringify(afterEventIds)) {
      return {
        message: 'Member event access updated successfully',
        data: { memberUserId, eventIds: afterEventIds },
      };
    }
    await this.replaceMemberEventAccess(row.id, organizationId, dto.eventIds);
    await this.recordOrganizationAuditLog({
      organizationId,
      actorUserId: ownerUserId,
      ip: clientIp ?? null,
      action: `Atualizou eventos do colaborador (${this.formatMemberNameForAudit({
        firstName: row.user.firstName,
        lastName: row.user.lastName,
        userId: memberUserId,
      })})`,
      metadata: {
        kind: 'MEMBER_EVENTS',
        page: dto.clientPage ?? 'member-events',
        memberUserId,
        fieldsEdited: ['eventIds'],
        changes: [
          { field: 'eventIds', old: beforeEventIds, new: afterEventIds },
        ],
        eventIds: afterEventIds,
      },
    });
    return {
      message: 'Member event access updated successfully',
      data: { memberUserId, eventIds: dto.eventIds },
    };
  }

  async getMemberDetail(
    ownerUserId: string,
    organizationId: string,
    memberUserId: string,
  ) {
    const prismaRead = this.prisma.getReadClient();
    if (!(await this.isOwner(ownerUserId, organizationId))) {
      throw new ForbiddenException('Only organization owner can view member details');
    }
    const row = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: memberUserId },
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            lastLoginAt: true,
            mfaEnabled: true,
          },
        },
        eventAccesses: { select: { eventId: true } },
      },
    });
    if (!row) {
      throw new NotFoundException('Member not found');
    }
    const permMap =
      row.role === 'OWNER'
        ? { ...FULL_ORGANIZER_PERMISSIONS }
        : effectivePermissionsForMember({
            role: row.role,
            permissionsJson: row.permissions,
          });
    const eventIds = await this.resolveMemberEventIdsForApi({
      role: row.role,
      organizationId,
      eventAccesses: row.eventAccesses,
      restrictedToEvents: row.restrictedToEvents,
    });
    const { eventAccesses: _ea, permissions: _perm, ...memberRest } = row;
    return {
      message: 'Member detail retrieved successfully',
      data: {
        member: memberRest,
        permissions: grantedPermissionKeys(permMap),
        eventIds,
        lastLoginAt: row.user.lastLoginAt ?? null,
      },
    };
  }

  async patchMemberSettings(
    ownerUserId: string,
    organizationId: string,
    memberUserId: string,
    dto: PatchMemberSettingsDto,
    clientIp?: string | null,
  ) {
    if (
      dto.role === undefined &&
      dto.permissions === undefined &&
      dto.eventIds === undefined &&
      dto.firstName === undefined &&
      dto.lastName === undefined
    ) {
      throw new BadRequestException('At least one field is required');
    }
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();
    if (!(await this.isOwner(ownerUserId, organizationId))) {
      throw new ForbiddenException('Only organization owner can update member settings');
    }
    const row = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: memberUserId },
      },
      include: {
        user: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
        eventAccesses: { select: { eventId: true } },
      },
    });
    if (!row) {
      throw new NotFoundException('Member not found');
    }

    const resultingRole =
      dto.role !== undefined ? dto.role : row.role;
    const appliedPermissionsUpdate =
      dto.permissions !== undefined && resultingRole !== 'OWNER';
    const appliedEventIdsUpdate =
      dto.eventIds !== undefined && resultingRole !== 'OWNER';

    if (dto.role !== undefined) {
      if (ownerUserId === memberUserId && dto.role !== 'OWNER') {
        throw new BadRequestException('Cannot change your own role from OWNER');
      }
      if (dto.role === 'OWNER' && ownerUserId !== memberUserId) {
        throw new BadRequestException(
          'Cannot assign OWNER role. Only one owner per organization.',
        );
      }
    }

    await prismaWrite.$transaction(async (tx) => {
      if (dto.firstName !== undefined || dto.lastName !== undefined) {
        await tx.user.update({
          where: { id: memberUserId },
          data: {
            ...(dto.firstName !== undefined && { firstName: dto.firstName }),
            ...(dto.lastName !== undefined && { lastName: dto.lastName }),
          },
        });
      }
      if (dto.role !== undefined) {
        await tx.organizationMember.update({
          where: {
            organizationId_userId: { organizationId, userId: memberUserId },
          },
          data: { role: dto.role },
        });
      }
      if (appliedPermissionsUpdate) {
        const normalized = this.normalizePutPermissions(dto.permissions!);
        await tx.organizationMember.update({
          where: {
            organizationId_userId: { organizationId, userId: memberUserId },
          },
          data: { permissions: normalized as unknown as Prisma.InputJsonValue },
        });
      }
      if (appliedEventIdsUpdate) {
        await this.assertEventsBelongToOrganization(organizationId, dto.eventIds);
        await tx.organizationMember.update({
          where: { id: row.id },
          data: { restrictedToEvents: true },
        });
        await tx.organizationMemberEventAccess.deleteMany({
          where: { organizationMemberId: row.id },
        });
        if (dto.eventIds!.length > 0) {
          await tx.organizationMemberEventAccess.createMany({
            data: dto.eventIds!.map((eventId) => ({
              organizationMemberId: row.id,
              eventId,
            })),
          });
        }
      }
    });

    const fresh = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: memberUserId },
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            lastLoginAt: true,
            mfaEnabled: true,
          },
        },
        eventAccesses: { select: { eventId: true } },
      },
    });
    if (!fresh) {
      throw new NotFoundException('Member not found');
    }

    const auditChanges: Array<{ field: string; old: unknown; new: unknown }> = [];
    if (dto.role !== undefined && fresh.role !== row.role) {
      auditChanges.push({ field: 'role', old: row.role, new: fresh.role });
    }
    if (appliedPermissionsUpdate && fresh.role !== 'OWNER') {
      const oldMap = effectivePermissionsForMember({
        role: row.role,
        permissionsJson: row.permissions,
      });
      const newMap = effectivePermissionsForMember({
        role: fresh.role,
        permissionsJson: fresh.permissions,
      });
      const oldK = grantedPermissionKeys(oldMap).slice().sort();
      const newK = grantedPermissionKeys(newMap).slice().sort();
      if (JSON.stringify(oldK) !== JSON.stringify(newK)) {
        auditChanges.push({
          field: 'permissions',
          old: oldK,
          new: newK,
        });
      }
    }
    if (appliedEventIdsUpdate && fresh.role !== 'OWNER') {
      const oldIds = (
        await this.resolveMemberEventIdsForApi({
          role: row.role,
          organizationId,
          eventAccesses: row.eventAccesses,
          restrictedToEvents: row.restrictedToEvents,
        })
      )
        .slice()
        .sort();
      const newIds = (
        await this.resolveMemberEventIdsForApi({
          role: fresh.role,
          organizationId,
          eventAccesses: fresh.eventAccesses,
          restrictedToEvents: fresh.restrictedToEvents,
        })
      )
        .slice()
        .sort();
      if (JSON.stringify(oldIds) !== JSON.stringify(newIds)) {
        auditChanges.push({
          field: 'eventIds',
          old: oldIds,
          new: newIds,
        });
      }
    }
    if (auditChanges.length > 0) {
      await this.recordOrganizationAuditLog({
        organizationId,
        actorUserId: ownerUserId,
        ip: clientIp ?? null,
        action: `Atualizou configurações do colaborador (${this.formatMemberNameForAudit({
          firstName: row.user.firstName,
          lastName: row.user.lastName,
          userId: memberUserId,
        })})`,
        metadata: {
          kind: 'MEMBER_SETTINGS',
          page: dto.clientPage ?? 'member-settings',
          memberUserId,
          fieldsEdited: auditChanges.map((c) => c.field),
          changes: auditChanges,
        } as Prisma.InputJsonValue,
      });
    }

    const permMap =
      fresh.role === 'OWNER'
        ? { ...FULL_ORGANIZER_PERMISSIONS }
        : effectivePermissionsForMember({
            role: fresh.role,
            permissionsJson: fresh.permissions,
          });
    const eventIds = await this.resolveMemberEventIdsForApi({
      role: fresh.role,
      organizationId,
      eventAccesses: fresh.eventAccesses,
      restrictedToEvents: fresh.restrictedToEvents,
    });
    const { eventAccesses: _e, permissions: _p, ...memberRest } = fresh;

    return {
      message: 'Member settings updated successfully',
      data: {
        member: memberRest,
        permissions: grantedPermissionKeys(permMap),
        eventIds,
        lastLoginAt: fresh.user.lastLoginAt ?? null,
      },
    };
  }

  async listOrganizationAuditLogs(
    requesterUserId: string,
    organizationId: string,
    query: OrganizationAuditLogQueryDto,
  ) {
    if (!(await this.isOwner(requesterUserId, organizationId))) {
      throw new ForbiddenException('Only organization owner can view audit logs');
    }
    const prismaRead = this.prisma.getReadClient();
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const where: Prisma.OrganizationAuditLogWhereInput = {
      organizationId,
    };
    if (query.q?.trim()) {
      where.action = {
        contains: query.q.trim(),
        mode: 'insensitive',
      };
    }
    if (query.from || query.to) {
      where.occurredAt = {};
      if (query.from) {
        (where.occurredAt as Prisma.DateTimeFilter).gte = new Date(query.from);
      }
      if (query.to) {
        const t = new Date(query.to);
        t.setUTCHours(23, 59, 59, 999);
        (where.occurredAt as Prisma.DateTimeFilter).lte = t;
      }
    }
    const [items, total] = await Promise.all([
      prismaRead.organizationAuditLog.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { occurredAt: 'desc' },
        include: {
          actor: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
      }),
      prismaRead.organizationAuditLog.count({ where }),
    ]);
    return {
      message: 'Audit logs fetched successfully',
      data: {
        items: items.map((row) => {
          const { action, editedFields } = formatAuditLogItemForResponse(
            row.action,
            row.metadata,
          );
          return {
            id: row.id,
            ip: row.ip,
            userId: row.actorUserId,
            userName: row.actor
              ? `${row.actor.firstName} ${row.actor.lastName}`.trim()
              : null,
            action,
            editedFields,
            occurredAt: row.occurredAt,
            metadata: row.metadata,
          };
        }),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 0,
        },
      },
    };
  }

  /**
   * Lista organizações com paginação (painel admin). Resposta enxuta + contagens.
   * Rota: por enquanto só JWT; checagem de papel admin pode ser reativada no controller.
   */
  async listOrganizationsAsAdmin(query: AdminOrganizationsListQueryDto) {
    const prismaRead = this.prisma.getReadClient();
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.OrganizationWhereInput = {};
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { tradeName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { document: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [organizations, total] = await Promise.all([
      prismaRead.organization.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          tradeName: true,
          document: true,
          logoUrl: true,
          email: true,
          phone: true,
          city: true,
          state: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: { members: true, events: true },
          },
        },
      }),
      prismaRead.organization.count({ where }),
    ]);

    return {
      message: 'Organizations fetched successfully',
      data: {
        organizations,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 0,
        },
      },
    };
  }

  /**
   * Lista todos os audit logs (todas as organizações), com metadata completa
   * e `changeDetails` quando houver `metadata.changes`.
   * Nota: a rota não exige papel admin até nova definição (só JWT).
   */
  async listAuditLogsAsAdmin(query: AdminAuditLogQueryDto) {
    const prismaRead = this.prisma.getReadClient();
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const where: Prisma.OrganizationAuditLogWhereInput = {};
    if (query.organizationId) {
      where.organizationId = query.organizationId;
    }
    if (query.q?.trim()) {
      where.action = {
        contains: query.q.trim(),
        mode: 'insensitive',
      };
    }
    if (query.from || query.to) {
      where.occurredAt = {};
      if (query.from) {
        (where.occurredAt as Prisma.DateTimeFilter).gte = new Date(query.from);
      }
      if (query.to) {
        const t = new Date(query.to);
        t.setUTCHours(23, 59, 59, 999);
        (where.occurredAt as Prisma.DateTimeFilter).lte = t;
      }
    }
    if (query.kind?.trim()) {
      where.metadata = {
        path: ['kind'],
        equals: query.kind.trim(),
      };
    }
    const userSearch = query.userSearch?.trim();
    if (userSearch) {
      where.actor = {
        OR: [
          { firstName: { contains: userSearch, mode: 'insensitive' } },
          { lastName: { contains: userSearch, mode: 'insensitive' } },
          { email: { contains: userSearch, mode: 'insensitive' } },
        ],
      };
    }
    const [items, total] = await Promise.all([
      prismaRead.organizationAuditLog.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { occurredAt: 'desc' },
        include: {
          actor: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
          organization: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      }),
      prismaRead.organizationAuditLog.count({ where }),
    ]);
    return {
      message: 'Audit logs fetched successfully (admin)',
      data: {
        items: items.map((row) => {
          const { action, editedFields } = formatAuditLogItemForResponse(
            row.action,
            row.metadata,
          );
          const meta =
            row.metadata &&
            typeof row.metadata === 'object' &&
            !Array.isArray(row.metadata)
              ? (row.metadata as Record<string, unknown>)
              : null;
          const kind =
            meta && typeof meta.kind === 'string' ? meta.kind : null;
          return {
            id: row.id,
            organizationId: row.organizationId,
            organization: row.organization,
            ip: row.ip,
            userId: row.actorUserId,
            userName: row.actor
              ? `${row.actor.firstName} ${row.actor.lastName}`.trim()
              : null,
            kind,
            action,
            editedFields,
            changeDetails: buildAuditChangeDetails(row.metadata),
            occurredAt: row.occurredAt,
            metadata: row.metadata,
            storedAction: row.action,
          };
        }),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 0,
        },
      },
    };
  }

  /**
   * [ADMIN] Adiciona um membro à organização (sem verificar se é owner)
   * Se userId não for fornecido, cria um novo usuário com os dados fornecidos
   */
  async addMemberAsAdmin(organizationId: string, addMemberDto: AddMemberDto) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Verificar se a organização existe
    const organization = await prismaRead.organization.findUnique({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    let userToAddId: string;

    // Se userId foi fornecido, usar usuário existente
    if (addMemberDto.userId) {
      const userToAdd = await prismaRead.user.findUnique({
        where: { id: addMemberDto.userId },
      });

      if (!userToAdd) {
        throw new NotFoundException('User not found');
      }

      // Verificar se o usuário tem accountType ORGANIZER
      if (userToAdd.accountType !== 'ORGANIZER') {
        throw new BadRequestException('User must have accountType ORGANIZER to be added as organization member');
      }

      userToAddId = addMemberDto.userId;
    } else {
      // Criar novo usuário
      if (!addMemberDto.firstName || !addMemberDto.lastName || !addMemberDto.email || !addMemberDto.password) {
        throw new BadRequestException('firstName, lastName, email and password are required when creating a new user');
      }

      // Verificar se email já existe (conta ORGANIZER)
      const existingUser = await prismaRead.user.findUnique({
        where: {
          email_accountType: {
            email: addMemberDto.email,
            accountType: 'ORGANIZER',
          },
        },
        include: {
          organizationMembers: {
            select: { organizationId: true },
          },
        },
      });

      if (existingUser) {
        const belongsToThisOrg = existingUser.organizationMembers.some(
          (m: any) => m.organizationId === organizationId,
        );
        if (belongsToThisOrg) {
          throw new ConflictException('Esse email já foi cadastrado.');
        }
        throw new ConflictException('Este usuário já está em uma organização.');
      }

      // Hash da senha
      const hashedPassword = await bcrypt.hash(addMemberDto.password, 12);

      // Gerar 2FA se solicitado
      let totpSecret: string | null = null;
      let mfaEnabled = false;
      if (addMemberDto.enable2FA) {
        const mfaResult = await this.mfaService.generateTOTPSecret('temp', addMemberDto.email);
        totpSecret = mfaResult.secret;
        mfaEnabled = true;
      }

      // Criar usuário (conta ORGANIZER)
      const newUser = await prismaWrite.user.create({
        data: {
          firstName: addMemberDto.firstName,
          lastName: addMemberDto.lastName,
          email: addMemberDto.email,
          accountType: 'ORGANIZER', // Conta de organizador
          password: hashedPassword,
          phone: addMemberDto.phone,
          totpSecret,
          mfaEnabled,
        },
      });

      userToAddId = newUser.id;
    }

    // Verificar se o usuário já é membro
    const existingMember = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId: userToAddId,
        },
      },
    });

    if (existingMember) {
      throw new BadRequestException('User is already a member of this organization');
    }

    // Não permitir adicionar outro OWNER via admin (apenas um OWNER por organização)
    if (addMemberDto.role === 'OWNER') {
      const existingOwner = await prismaRead.organizationMember.findFirst({
        where: {
          organizationId,
          role: 'OWNER',
        },
      });

      if (existingOwner) {
        throw new BadRequestException('Organization already has an owner. Remove the current owner first or update their role.');
      }
    }

    const permissionsForMember =
      addMemberDto.role === 'OWNER'
        ? Prisma.JsonNull
        : (this.normalizeNewMemberPermissions(
            addMemberDto.permissions,
          ) as Prisma.InputJsonValue);

    if (addMemberDto.eventIds?.length) {
      await this.assertEventsBelongToOrganization(
        organizationId,
        addMemberDto.eventIds,
      );
    }

    const member = await prismaWrite.$transaction(async (tx) => {
      const created = await tx.organizationMember.create({
        data: {
          organizationId,
          userId: userToAddId,
          role: addMemberDto.role,
          permissions: permissionsForMember,
        },
      });

      if (
        addMemberDto.eventIds?.length &&
        addMemberDto.role !== 'OWNER'
      ) {
        await tx.organizationMemberEventAccess.createMany({
          data: addMemberDto.eventIds.map((eventId) => ({
            organizationMemberId: created.id,
            eventId,
          })),
        });
      }

      return tx.organizationMember.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              mfaEnabled: true,
            },
          },
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
          eventAccesses: { select: { eventId: true } },
        },
      });
    });

    // Se for OWNER, atualizar role e accountType do usuário (accountType é usado no login/organizer)
    if (addMemberDto.role === 'OWNER') {
      await prismaWrite.user.update({
        where: { id: userToAddId },
        data: { role: 'ORGANIZER', accountType: 'ORGANIZER' },
      });
    }

    // Dispara email de boas-vindas ao novo membro (fire-and-forget)
    const registeredAt = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    }).format(new Date()).replace(',', ' ·');

    this.emailService
      .sendMemberAdded({
        recipientEmail: member.user.email,
        firstName: member.user.firstName ?? member.user.email,
        orgName: member.organization.name,
        registeredAt,
      })
      .catch((err: any) =>
        this.logger.warn(`Falha ao enviar email de boas-vindas ao membro (userId=${member.userId}): ${err?.message ?? err}`),
      );

    return {
      message: 'Member added successfully',
      data: { member },
    };
  }

  /**
   * [ADMIN] Atualiza o role de um membro (sem verificar se é owner)
   */
  async updateMemberRoleAsAdmin(
    organizationId: string,
    memberUserId: string,
    updateDto: UpdateMemberRoleDto,
  ) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Verificar se o membro existe
    const member = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId: memberUserId,
        },
      },
    });

    if (!member) {
      throw new NotFoundException('Member not found');
    }

    // Se estiver mudando para OWNER, verificar se já existe um OWNER
    if (updateDto.role === 'OWNER' && member.role !== 'OWNER') {
      const existingOwner = await prismaRead.organizationMember.findFirst({
        where: {
          organizationId,
          role: 'OWNER',
        },
      });

      if (existingOwner) {
        throw new BadRequestException('Organization already has an owner. Remove the current owner first or update their role.');
      }
    }

    // Atualizar role
    const updatedMember = await prismaWrite.organizationMember.update({
      where: {
        organizationId_userId: {
          organizationId,
          userId: memberUserId,
        },
      },
      data: {
        role: updateDto.role,
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
        organization: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    // Atualizar role do usuário se necessário
    const wasOwner = member.role === 'OWNER';
    const willBeOwner = updateDto.role === 'OWNER';

    if (willBeOwner && !wasOwner) {
      // Tornando-se OWNER - atualizar role e accountType (accountType é usado no login/organizer)
      await prismaWrite.user.update({
        where: { id: memberUserId },
        data: { role: 'ORGANIZER', accountType: 'ORGANIZER' },
      });
    }
    // Se estava removendo o OWNER (wasOwner && !willBeOwner), mantemos o role como ORGANIZER

    return {
      message: 'Member role updated successfully',
      data: { member: updatedMember },
    };
  }

  /**
   * [ADMIN] Remove um membro da organização (sem verificar se é owner)
   */
  async removeMemberAsAdmin(organizationId: string, memberUserId: string) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Verificar se o membro existe
    const member = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId,
          userId: memberUserId,
        },
      },
    });

    if (!member) {
      throw new NotFoundException('Member not found');
    }

    // Remover membro e deletar usuário em uma única transação
    await prismaWrite.$transaction(async (tx: any) => {
      await tx.organizationMember.delete({
        where: {
          organizationId_userId: {
            organizationId,
            userId: memberUserId,
          },
        },
      });

      await tx.user.delete({
        where: { id: memberUserId },
      });
    });

    return {
      message: 'Member removed successfully',
    };
  }
}
