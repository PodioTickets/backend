import { Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateOrganizationDto, AddMemberDto, UpdateMemberRoleDto, UpdateOrganizationDto } from './dto/organization.dto';
import { OrganizationMemberRole } from '@prisma/client';
import { MFAService } from '../../common/services/mfa.service';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mfaService: MFAService,
  ) {}

  /**
   * Limpa o documentNumber removendo formatação
   */
  private cleanDocumentNumber(documentNumber?: string | null): string | null {
    if (!documentNumber) return null;
    return documentNumber.replace(/\D/g, '');
  }

  /**
   * Cria uma organização e atribui um usuário como OWNER
   * Se userId não for fornecido, cria um novo usuário com os dados fornecidos
   */
  async createOrganization(createDto: CreateOrganizationDto) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Se userId não foi fornecido, validar dados do owner
    if (!createDto.userId) {
      // Validar que os dados do owner foram fornecidos
      if (!createDto.ownerEmail || !createDto.ownerPassword || !createDto.ownerFirstName || !createDto.ownerLastName) {
        throw new BadRequestException('Either userId or owner data (email, password, firstName, lastName) is required');
      }

      // Verificar se email já existe (conta ORGANIZER)
      const existingUserByEmail = await prismaRead.user.findUnique({
        where: { 
          email_accountType: {
            email: createDto.ownerEmail,
            accountType: 'ORGANIZER',
          }
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
              }
            },
          });

          if (existingUserByCpf) {
            throw new ConflictException('User with this document number already exists');
          }
        }
      }
    } else {
      // Verificar se o usuário existe
      const user = await prismaRead.user.findUnique({
        where: { id: createDto.userId },
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      // Verificar se o usuário já é OWNER de alguma organização
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

    // Criar organização, usuário (se necessário) e membro OWNER em uma transação
    const result = await prismaWrite.$transaction(async (tx) => {
      let userId: string;

      // Se userId não foi fornecido, criar novo usuário dentro da transação
      if (!createDto.userId) {
        const hashedPassword = await bcrypt.hash(createDto.ownerPassword!, 12);
        const documentNumberClean = createDto.ownerDocumentNumber 
          ? this.cleanDocumentNumber(createDto.ownerDocumentNumber)
          : null;

        const newUser = await tx.user.create({
          data: {
            email: createDto.ownerEmail!,
            accountType: 'ORGANIZER', // Conta de organizador
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

        // Verificar novamente dentro da transação se o usuário já é OWNER
        const existingMember = await tx.organizationMember.findFirst({
          where: {
            userId,
            role: 'OWNER',
          },
        });

        if (existingMember) {
          throw new BadRequestException('User is already an owner of an organization');
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
          pix: createDto.pix,
          bankName: createDto.bankName,
          bankCode: createDto.bankCode,
          agency: createDto.agency,
          account: createDto.account,
          accountType: createDto.accountType,
          accountHolderName: createDto.accountHolderName,
          accountHolderDocument: createDto.accountHolderDocument,
        },
      });

      // Criar o membro da organização com role OWNER
      const member = await tx.organizationMember.create({
        data: {
          organizationId: organization.id,
          userId,
          role: 'OWNER',
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
          organization: true,
        },
      });

      // Atualizar role do usuário para ORGANIZER
      await tx.user.update({
        where: { id: userId },
        data: { role: 'ORGANIZER' },
      });

      return { organization, member };
    });

    return {
      message: 'Organization created successfully',
      data: {
        organization: result.organization,
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
        role: 'OWNER',
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
          },
        },
      },
    });

    if (!member) {
      throw new NotFoundException('Organizer not found');
    }

    return {
      message: 'Organization fetched successfully',
      data: { organization: member.organization },
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
  async addMember(userId: string, organizationId: string, addMemberDto: AddMemberDto) {
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
          }
        },
      });

      if (existingUser) {
        throw new BadRequestException('User with this email already exists');
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

    // Criar membro
    const member = await prismaWrite.organizationMember.create({
      data: {
        organizationId,
        userId: userToAddId,
        role: addMemberDto.role,
      },
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
      },
    });

    return {
      message: 'Member added successfully',
      data: { member },
    };
  }

  /**
   * Remove um membro da organização (apenas dono)
   */
  async removeMember(userId: string, organizationId: string, memberUserId: string) {
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
    });

    if (!member) {
      throw new NotFoundException('Member not found');
    }

    // Remover membro
    await prismaWrite.organizationMember.delete({
      where: {
        organizationId_userId: {
          organizationId,
          userId: memberUserId,
        },
      },
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
          },
        },
      },
      orderBy: [
        { role: 'asc' }, // OWNER primeiro
        { createdAt: 'asc' },
      ],
    });

    return {
      message: 'Members fetched successfully',
      data: { members },
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
          }
        },
      });

      if (existingUser) {
        throw new BadRequestException('User with this email already exists');
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

    // Criar membro
    const member = await prismaWrite.organizationMember.create({
      data: {
        organizationId,
        userId: userToAddId,
        role: addMemberDto.role,
      },
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
      },
    });

    // Se for OWNER, atualizar role do usuário
    if (addMemberDto.role === 'OWNER') {
      await prismaWrite.user.update({
        where: { id: userToAddId },
        data: { role: 'ORGANIZER' },
      });
    }

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
      // Tornando-se OWNER - atualizar role do usuário
      await prismaWrite.user.update({
        where: { id: memberUserId },
        data: { role: 'ORGANIZER' },
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

    // Remover membro
    await prismaWrite.organizationMember.delete({
      where: {
        organizationId_userId: {
          organizationId,
          userId: memberUserId,
        },
      },
    });

    return {
      message: 'Member removed successfully',
    };
  }
}
