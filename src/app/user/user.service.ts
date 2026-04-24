import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateLinkedUserDto } from './dto/create-linked-user.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Limpa o documentNumber removendo formatação (pontos, traços, barras, espaços)
   * @param documentNumber - CPF/CNPJ com ou sem formatação
   * @returns Documento limpo (apenas números) ou null se não fornecido
   */
  private cleanDocumentNumber(documentNumber?: string | null): string | null {
    if (!documentNumber) return null;
    return documentNumber.replace(/\D/g, '');
  }

  private validatePasswordStrength(password: string): void {
    const passwordRegex =
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

    if (!passwordRegex.test(password)) {
      throw new BadRequestException(
        'Password must be at least 8 characters long and contain at least one lowercase letter, one uppercase letter, one number, and one special character (@$!%*?&)',
      );
    }

    // Verificar senhas comuns (blacklist básica)
    const commonPasswords = [
      'password',
      '123456',
      '123456789',
      'qwerty',
      'abc123',
      'password123',
      'admin',
      'letmein',
      'welcome',
      'monkey',
    ];

    if (commonPasswords.includes(password.toLowerCase())) {
      throw new BadRequestException(
        'Password is too common. Please choose a more secure password.',
      );
    }

    // Verificar sequências simples
    const sequentialPatterns = [
      '123456',
      'abcdef',
      'qwerty',
      'asdfgh',
      'zxcvbn',
    ];

    if (
      sequentialPatterns.some((pattern) =>
        password.toLowerCase().includes(pattern),
      )
    ) {
      throw new BadRequestException(
        'Password contains sequential characters. Please choose a more secure password.',
      );
    }
  }

  async create(createUserDto: CreateUserDto) {
    // Validar força da senha se fornecida
    if (createUserDto.password) {
      this.validatePasswordStrength(createUserDto.password);
    }

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Verificar se email já existe (conta USER)
    const existingUserByEmail = await prismaRead.user.findUnique({
      where: { 
        email_accountType: {
          email: createUserDto.email,
          accountType: 'USER',
        }
      },
    });

    if (existingUserByEmail) {
      throw new ConflictException('User with this email already exists');
    }

    // Verificar se CPF já existe (se fornecido)
    if (createUserDto.documentNumber) {
      const documentNumberClean = this.cleanDocumentNumber(createUserDto.documentNumber);
      const existingUserByCpf = await prismaRead.user.findUnique({
        where: { 
          documentNumberClean_accountType: {
            documentNumberClean,
            accountType: 'USER',
          }
        },
      });

      if (existingUserByCpf) {
        throw new ConflictException('User with this document number already exists');
      }
    }

    try {
      const hashedPassword = createUserDto.password
        ? await bcrypt.hash(createUserDto.password, 12)
        : undefined;

      const user = await prismaWrite.user.create({
        data: {
          ...createUserDto,
          accountType: 'USER', // Conta de usuário normal
          password: hashedPassword || '',
          dateOfBirth: createUserDto.dateOfBirth
            ? new Date(createUserDto.dateOfBirth)
            : null,
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          documentNumber: true,
          role: true,
          isActive: true,
          avatarUrl: true,
        },
      });
      return {
        message: 'User created successfully',
        data: { user },
      };
    } catch (error) {
      // Handle Prisma unique constraint violations
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = error.meta?.target as string[];
        if (target?.includes('email')) {
          throw new ConflictException('User with this email already exists');
        }
        if (target?.includes('documentNumber')) {
          throw new ConflictException('User with this document number already exists');
        }
        throw new ConflictException('User already exists');
      }

      // Log do erro completo para debug
      console.error('User creation error:', error);
      throw new BadRequestException(
        error?.message || 'Failed to create user',
      );
    }
  }

  async findAll(params?: { page?: number; limit?: number }) {
    const { page = 1, limit = 50 } = params || {};

    const prismaRead = this.prisma.getReadClient();

    const users = await prismaRead.user.findMany({
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        documentNumber: true,
        role: true,
        isActive: true,
        avatarUrl: true,
        createdAt: true,
      },
    });
    return {
      message: 'Users fetched successfully',
      data: { users, page, limit },
    };
  }

  async findOne(id: string) {
    const prismaRead = this.prisma.getReadClient();

    const user = await prismaRead.user.findUnique({
      where: { id },
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
        documentNumberClean: true,
        genderDetails: true,
        acceptedTerms: true,
        acceptedPrivacyPolicy: true,
        receiveCalendarEvents: true,
        receivePartnerPromos: true,
        language: true,
        role: true,
        isActive: true,
        avatarUrl: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      message: 'User fetched successfully',
      data: { user },
    };
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    if (updateUserDto.password) {
      this.validatePasswordStrength(updateUserDto.password);
      updateUserDto.password = await bcrypt.hash(updateUserDto.password, 12);
    }

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const updateData: any = { ...updateUserDto };

    // Mesma regra do registro (auth): unicidade por (documentNumberClean, accountType)
    if (updateData.documentNumber !== undefined) {
      const currentUser = await prismaRead.user.findUnique({
        where: { id },
        select: { accountType: true },
      });
      if (!currentUser) {
        throw new NotFoundException('User not found');
      }

      const documentNumberClean = this.cleanDocumentNumber(updateData.documentNumber);

      if (documentNumberClean) {
        const owner = await prismaRead.user.findUnique({
          where: {
            documentNumberClean_accountType: {
              documentNumberClean,
              accountType: currentUser.accountType,
            },
          },
          select: { id: true },
        });

        if (owner && owner.id !== id) {
          throw new ConflictException(
            'User with this document number already exists',
          );
        }
      }

      updateData.documentNumberClean = documentNumberClean;
    }
    
    if ('emergencyPhone' in updateData) {
      updateData.reservePhone = updateData.emergencyPhone ?? null;
      delete updateData.emergencyPhone;
    }
    
    if (updateData.dateOfBirth) {
      updateData.dateOfBirth = new Date(updateData.dateOfBirth);
    }

    const user = await prismaWrite.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        documentNumber: true,
        role: true,
        isActive: true,
      },
    });
    return {
      message: 'User updated successfully',
      data: { user },
    };
  }

  async remove(id: string) {
    const prismaWrite = this.prisma.getWriteClient();
    
    await prismaWrite.user.delete({
      where: { id },
    });
    return {
      message: 'User removed successfully',
    };
  }

  async getLinkedUsers(mainUserId: string) {
    const prismaRead = this.prisma.getReadClient();

    const mainUser = await prismaRead.user.findUnique({
      where: { id: mainUserId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        documentNumber: true,
        phone: true,
        dateOfBirth: true,
        gender: true,
        avatarUrl: true,
      },
    });

    if (!mainUser) {
      throw new NotFoundException('User not found');
    }

    const linkedProfiles = await prismaRead.linkedUser.findMany({
      where: { mainUserId },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });

    const users = [
      {
        ...mainUser,
        isMainUser: true,
        gender: this.mapGenderFromEnum(mainUser.gender),
        dateOfBirth: mainUser.dateOfBirth ? mainUser.dateOfBirth.toISOString().split('T')[0] : null,
      },
      ...linkedProfiles.map((lp) => ({
        id: lp.id,
        firstName: lp.firstName,
        lastName: lp.lastName,
        email: lp.email,
        documentNumber: lp.documentNumber,
        phone: lp.phone,
        dateOfBirth: lp.dateOfBirth ? lp.dateOfBirth.toISOString().split('T')[0] : null,
        gender: lp.gender,
        isMainUser: false,
      })),
    ];

    return { success: true, data: { users } };
  }

  async createOrLinkUser(mainUserId: string, dto: CreateLinkedUserDto) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const dateOfBirth = new Date(dto.dateOfBirth);
    if (dateOfBirth > new Date()) {
      throw new BadRequestException('Data de nascimento não pode ser futura');
    }

    const documentNumberClean = this.cleanDocumentNumber(dto.documentNumber);

    if (documentNumberClean) {
      const existing = await prismaRead.linkedUser.findUnique({
        where: { mainUserId_documentNumberClean: { mainUserId, documentNumberClean } },
      });

      if (existing) {
        const updated = await prismaWrite.linkedUser.update({
          where: { id: existing.id },
          data: {
            firstName: dto.firstName,
            lastName: dto.lastName,
            email: dto.email,
            phone: dto.phone,
            dateOfBirth,
            gender: dto.gender,
          },
        });
        return { success: true, data: this.formatLinkedProfile(updated) };
      }
    }

    const created = await prismaWrite.linkedUser.create({
      data: {
        mainUserId,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email ?? null,
        documentNumber: dto.documentNumber ?? null,
        documentNumberClean: documentNumberClean,
        phone: dto.phone,
        dateOfBirth,
        gender: dto.gender ?? null,
        relationshipType: 'outro',
      },
    });

    return { success: true, data: this.formatLinkedProfile(created) };
  }

  async findUserByCpf(cpf: string) {
    const prismaRead = this.prisma.getReadClient();
    const documentNumberClean = cpf.replace(/\D/g, '');

    const user = await prismaRead.user.findUnique({
      where: {
        documentNumberClean_accountType: { documentNumberClean, accountType: 'USER' },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        documentNumber: true,
        phone: true,
        dateOfBirth: true,
        gender: true,
      },
    });

    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    return {
      success: true,
      data: {
        ...user,
        gender: this.mapGenderFromEnum(user.gender),
        dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toISOString().split('T')[0] : null,
      },
    };
  }

  private formatLinkedProfile(lp: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    documentNumber: string | null;
    phone: string | null;
    dateOfBirth: Date | null;
    gender: string | null;
  }) {
    return {
      id: lp.id,
      firstName: lp.firstName,
      lastName: lp.lastName,
      email: lp.email,
      documentNumber: lp.documentNumber,
      phone: lp.phone,
      dateOfBirth: lp.dateOfBirth ? lp.dateOfBirth.toISOString().split('T')[0] : null,
      gender: lp.gender,
    };
  }

  private mapGenderFromEnum(
    gender: 'MALE' | 'FEMALE' | 'OTHER' | 'PREFER_NOT_TO_SAY' | null,
  ): string | null {
    const mapping: Record<string, string> = {
      MALE: 'masculino',
      FEMALE: 'feminino',
      OTHER: 'outro',
      PREFER_NOT_TO_SAY: 'prefiro-nao-dizer',
    };
    return gender ? (mapping[gender] ?? null) : null;
  }
}

