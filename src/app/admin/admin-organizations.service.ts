import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { OrganizationAdvisor, Prisma } from '@prisma/client';
import {
  effectivePermissionsForMember,
  grantedPermissionKeys,
  mapFromPermissionKeys,
  UnknownOrganizerPermissionKeyError,
} from '../organizations/constants/organizer-permissions';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheRedisService } from '../../common/services/cache-redis.service';

@Injectable()
export class AdminOrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheRedisService,
  ) {}

  async getOrganizations(params: {
    page: number;
    limit: number;
    search?: string;
    isActive?: boolean;
  }) {
    const { page, limit, search, isActive } = params;
    const skip = (page - 1) * limit;

    const prismaRead = this.prisma.getReadClient();

    const where: any = {};
    if (isActive !== undefined) where.isActive = isActive;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { tradeName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { document: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [organizations, total] = await Promise.all([
      prismaRead.organization.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          tradeName: true,
          email: true,
          logoUrl: true,
          document: true,
          phone: true,
          city: true,
          state: true,
          isActive: true,
          createdAt: true,
          _count: {
            select: { events: true, members: true },
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
          totalPages: Math.ceil(total / limit),
        },
      },
    };
  }

  async getOrganization(id: string) {
    const prismaRead = this.prisma.getReadClient();

    const organization = await prismaRead.organization.findUnique({
      where: { id },
      include: {
        members: {
          select: {
            id: true,
            role: true,
            createdAt: true,
            // Cru aqui, convertido para chaves efetivas abaixo — a listagem
            // alimenta a pintura inicial do drawer e precisa concordar com o
            // detalhe, senão pisca o conjunto errado antes do GET responder.
            permissions: true,
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                avatarUrl: true,
                role: true,
                isActive: true,
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
        _count: {
          select: { events: true, members: true },
        },
      },
    });

    if (!organization) throw new NotFoundException('Organization not found');

    const members = organization.members.map((m) => ({
      ...m,
      permissions: grantedPermissionKeys(
        effectivePermissionsForMember({
          role: m.role,
          permissionsJson: m.permissions,
        }),
      ),
    }));

    return {
      message: 'Organization fetched successfully',
      data: { organization: { ...organization, members } },
    };
  }

  async updateOrganization(
    id: string,
    dto: UpdateOrganizationDto & { pixKeyType?: string; pix?: string; pixKeys?: { key: string; keyType: string; isDefault?: boolean; bankName?: string; accountHolderName?: string; accountHolderDocument?: string }[] },
  ) {
    const existing = await this.prisma.getReadClient().organization.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Organization not found');

    // Documento (CPF/CNPJ) é UNIQUE. Ao trocar (ex.: PJ→PF muda CNPJ→CPF do
    // responsável), o CPF pode já pertencer a OUTRA organização. Validamos ANTES
    // do update pra retornar um 409 com CÓDIGO tipado (DUPLICATE_DOCUMENT), que o
    // front roteia direto pro input do documento — em vez do P2002 cru virar toast.
    const documentClean = dto.document?.replace(/\D/g, '');
    if (documentClean) {
      const clash = await this.prisma.getReadClient().organization.findFirst({
        where: { document: documentClean, id: { not: id } },
        select: { id: true, name: true },
      });
      if (clash) {
        throw new ConflictException({
          code: 'DUPLICATE_DOCUMENT',
          message: `Já existe uma organização cadastrada com este documento (CPF/CNPJ)${clash.name ? `: ${clash.name}` : ''}.`,
        });
      }
    }

    // Extrair campos que não pertencem ao model Organization
    const { pixKeyType: _pixKeyType, pix: _pix, pixKeys, ...data } = dto as any;
    // Persistir o documento só com dígitos (consistente com o unique e com a
    // inferência PF/PJ por tamanho no front: 11=CPF, 14=CNPJ).
    if (data.document != null) data.document = documentClean ?? '';

    const w = this.prisma.getWriteClient();

    const [updated] = await Promise.all([
      w.organization.update({
        where: { id },
        data,
        select: {
          id: true,
          name: true,
          tradeName: true,
          email: true,
          fiscalEmail: true,
          logoUrl: true,
          document: true,
          phone: true,
          whatsapp: true,
          siteUrl: true,
          instagram: true,
          description: true,
          zipCode: true,
          street: true,
          number: true,
          neighborhood: true,
          city: true,
          state: true,
          ownerName: true,
          ownerDocument: true,
          bankName: true,
          bankCode: true,
          agency: true,
          account: true,
          accountType: true,
          accountHolderName: true,
          accountHolderDocument: true,
          anticipationMonthlyRate: true,
          anticipationEnabled: true,
          customFeeEnabled: true,
          maxTotalFeePercent: true,
          advisor: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      // Substituição completa das chaves PIX quando enviadas
      pixKeys != null
        ? w.$transaction(async (tx: any) => {
            await tx.organizationPixKey.deleteMany({ where: { organizationId: id } });
            if ((pixKeys as any[]).length > 0) {
              // Garantir no máximo um isDefault=true
              const hasDefault = (pixKeys as any[]).some((k: any) => k.isDefault);
              await tx.organizationPixKey.createMany({
                data: (pixKeys as any[]).map((k: any, i: number) => ({
                  organizationId: id,
                  key: k.key,
                  keyType: k.keyType,
                  isDefault: hasDefault ? !!k.isDefault : i === 0,
                  bankName: k.bankName ?? null,
                  accountHolderName: k.accountHolderName ?? null,
                  accountHolderDocument: k.accountHolderDocument ?? null,
                })),
              });
            }
          })
        : Promise.resolve(),
    ]);

    const savedPixKeys = await this.prisma.getReadClient().organizationPixKey.findMany({
      where: { organizationId: id },
      select: { id: true, key: true, keyType: true, isDefault: true, bankName: true, accountHolderName: true, accountHolderDocument: true, createdAt: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });

    // Invalida cache de sessão dos organizadores quando a org é desativada
    if (data.isActive === false) {
      const members = await this.prisma.getReadClient().organizationMember.findMany({
        where: { organizationId: id },
        select: { userId: true },
      });
      const keys = members.map((m) => `organizer_active:${m.userId}`);
      if (keys.length > 0) await this.cache.del(keys);
    }

    return {
      message: 'Organization updated successfully',
      data: { organization: { ...updated, pixKeys: savedPixKeys } },
    };
  }

  async updateMember(
    organizationId: string,
    memberUserId: string,
    dto: {
      role?: string;
      permissions?: string[];
      eventIds?: string[];
      firstName?: string;
      lastName?: string;
    },
  ) {
    const w = this.prisma.getWriteClient();
    const r = this.prisma.getReadClient();

    const member = await r.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: memberUserId } },
    });
    if (!member) throw new NotFoundException('Membro não encontrado');

    const data: Prisma.OrganizationMemberUpdateInput = {};
    if (dto.role !== undefined) {
      data.role = dto.role as Prisma.OrganizationMemberUpdateInput['role'];
    }

    // Permissões são gravadas como MAPA canônico (`{ financial: true, ... }`),
    // igual ao fluxo do organizador. Antes ia o array cru do payload, que o
    // leitor (`fullPermissionsMapFromJson`) não entendia — e "não entendido"
    // caía em acesso TOTAL, então restringir pelo admin liberava tudo.
    // OWNER tem acesso total implícito; não guardamos mapa para ele (mesmo
    // critério de `addMemberAsAdmin` e de `patchMemberSettings`).
    const resultingRole = dto.role ?? member.role;
    if (dto.permissions !== undefined && resultingRole !== 'OWNER') {
      try {
        data.permissions = mapFromPermissionKeys(
          dto.permissions,
        ) as unknown as Prisma.InputJsonValue;
      } catch (err) {
        if (err instanceof UnknownOrganizerPermissionKeyError) {
          throw new BadRequestException(
            `Permissão desconhecida: ${err.raw}`,
          );
        }
        throw err;
      }
    }

    // O NOME vive no `User`, não no `OrganizationMember`. A DTO já aceitava
    // firstName/lastName (o painel os envia), mas nada os gravava — a edição do
    // nome era aceita e descartada em silêncio. Mesma semântica do caminho do
    // organizador (`organizations.service.patchMemberSettings`).
    const userNameData: Prisma.UserUpdateInput = {};
    if (dto.firstName !== undefined) userNameData.firstName = dto.firstName;
    if (dto.lastName !== undefined) userNameData.lastName = dto.lastName;
    const hasNameUpdate = Object.keys(userNameData).length > 0;

    // Promover a OWNER/MANAGER também promove a conta do usuário. Nome, vínculo e
    // promoção numa transação só: sem isso um erro no meio deixa o membro com
    // papel novo e nome velho (ou vice-versa).
    const promotesAccount = dto.role === 'OWNER' || dto.role === 'MANAGER';

    const updated = await w.$transaction(async (tx) => {
      if (hasNameUpdate) {
        await tx.user.update({ where: { id: memberUserId }, data: userNameData });
      }
      if (promotesAccount) {
        await tx.user.update({
          where: { id: memberUserId },
          data: { role: 'ORGANIZER', accountType: 'ORGANIZER' },
        });
      }
      return tx.organizationMember.update({
        where: { organizationId_userId: { organizationId, userId: memberUserId } },
        data,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        },
      });
    });

    return { message: 'Member updated successfully', data: { member: updated } };
  }

  async getMember(organizationId: string, memberUserId: string) {
    const prismaRead = this.prisma.getReadClient();

    const row = await prismaRead.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: memberUserId } },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            avatarUrl: true,
            lastLoginAt: true,
            mfaEnabled: true,
            isActive: true,
          },
        },
        eventAccesses: { select: { eventId: true } },
      },
    });

    if (!row) throw new NotFoundException('Membro não encontrado');

    // Permissões EFETIVAS, e não a coluna JSON crua: é o mesmo cálculo do
    // detalhe do organizador (`organizations.service.getMemberDetail`), então
    // os dois painéis passam a exibir exatamente o mesmo conjunto.
    // Entregar o JSON cru deixava a interpretação por conta de cada front —
    // e a do admin reidratava chaves AUSENTES com o default (`view_event`),
    // reexibindo permissão que o organizador tinha acabado de remover.
    // Também cobre de graça os shapes legados (array), `null` = acesso total e
    // OWNER (sem mapa gravado).
    const permissions = grantedPermissionKeys(
      effectivePermissionsForMember({
        role: row.role,
        permissionsJson: row.permissions,
      }),
    );

    const { permissions: _rawPermissions, eventAccesses, ...memberRest } = row;

    return {
      message: 'Member retrieved successfully',
      data: {
        // `permissions` no membro E na raiz: mesma forma do contrato do
        // organizador, que o front já sabe ler.
        member: { ...memberRest, eventAccesses, permissions },
        permissions,
        eventIds: eventAccesses.map((e) => e.eventId),
      },
    };
  }
}

export interface UpdateOrganizationDto {
  name?: string;
  tradeName?: string;
  document?: string;
  email?: string;
  fiscalEmail?: string;
  phone?: string;
  whatsapp?: string;
  siteUrl?: string;
  instagram?: string;
  description?: string;
  zipCode?: string;
  street?: string;
  number?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
  ownerName?: string;
  ownerDocument?: string;
  bankName?: string;
  bankCode?: string;
  agency?: string;
  account?: string;
  accountType?: string;
  accountHolderName?: string;
  accountHolderDocument?: string;
  isActive?: boolean;
  anticipationMonthlyRate?: number;
  anticipationEnabled?: boolean;
  advisor?: OrganizationAdvisor;
}
