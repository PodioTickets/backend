import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateLinkedUserDto } from './dto/create-linked-user.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../../common/services/email.service';
import { DocumentType, Prisma } from '@prisma/client';
import {
  cleanDocumentNumber as cleanDoc,
  inferDocumentType,
} from '../../common/utils/document.util';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Wrapper sobre `cleanDocumentNumber` do util compartilhado. Mantém a
   * assinatura antiga (retorna null pra entrada vazia) usada por todos os
   * call-sites internos pra preservar `Prisma.update({ documentNumberClean })`
   * com null explícito.
   */
  private cleanDocumentNumber(
    documentNumber?: string | null,
    documentType?: DocumentType | null,
  ): string | null {
    if (!documentNumber) return null;
    const out = cleanDoc(documentNumber, documentType ?? DocumentType.CPF);
    return out.length > 0 ? out : null;
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
      throw new ConflictException('Já existe um usuário com este e-mail');
    }

    // Verificar se documento já existe (se fornecido) — normaliza conforme o tipo
    const documentNumberClean = createUserDto.documentNumber
      ? this.cleanDocumentNumber(
          createUserDto.documentNumber,
          createUserDto.documentType as any,
        )
      : null;

    if (documentNumberClean) {
      const existingUserByCpf = await prismaRead.user.findUnique({
        where: {
          documentNumberClean_accountType: {
            documentNumberClean,
            accountType: 'USER',
          },
        },
      });

      if (existingUserByCpf) {
        throw new ConflictException('Já existe um usuário com este CPF');
      }
    }

    try {
      const hashedPassword = createUserDto.password
        ? await bcrypt.hash(createUserDto.password, 12)
        : undefined;

      const user = await prismaWrite.user.create({
        data: {
          ...createUserDto,
          // Sobrescreve depois do spread: documentNumber e documentNumberClean
          // sempre iguais (só letras/números). Mesma regra do register e patch.
          documentNumber: documentNumberClean,
          documentNumberClean,
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
          throw new ConflictException('Já existe um usuário com este e-mail');
        }
        if (target?.includes('documentNumber')) {
          throw new ConflictException('Já existe um usuário com este CPF');
        }
        throw new ConflictException('Usuário já existe');
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
      throw new NotFoundException('Usuário não encontrado');
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

    // Detect first-time profile completion for Google OAuth users.
    // Google OAuth creates accounts with no phone; when phone is first set the
    // profile is considered complete and the welcome email should be sent.
    let isFirstProfileCompletion = false;
    if (updateUserDto.phone) {
      const existing = await prismaRead.user.findUnique({
        where: { id },
        select: { phone: true, googleId: true },
      });
      if (existing && !existing.phone && existing.googleId) {
        isFirstProfileCompletion = true;
      }
    }

    const updateData: any = { ...updateUserDto };

    // Mesma regra do registro (auth): unicidade por (documentNumberClean, accountType)
    if (updateData.documentNumber !== undefined) {
      const currentUser = await prismaRead.user.findUnique({
        where: { id },
        select: { accountType: true },
      });
      if (!currentUser) {
        throw new NotFoundException('Usuário não encontrado');
      }

      const documentNumberClean = this.cleanDocumentNumber(
        updateData.documentNumber,
        updateData.documentType ?? null,
      );

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
      // documentNumber também recebe a versão limpa — sem dual-format
      // entre os 2 campos. Se o front enviou null/'', mantém null.
      updateData.documentNumber = documentNumberClean;
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

    if (isFirstProfileCompletion && user.email && user.firstName) {
      this.emailService.sendWelcomeUser({ email: user.email, firstName: user.firstName })
        .catch((err) => this.logger.warn('Failed to send welcome email after profile completion:', err));
    }

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
        documentType: true,
        documentNumber: true,
        country: true,
        phone: true,
        dateOfBirth: true,
        gender: true,
        avatarUrl: true,
      },
    });

    if (!mainUser) {
      throw new NotFoundException('Usuário não encontrado');
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
      // Linked profiles ainda não têm country próprio — herdamos do mainUser
      // como melhor aproximação até existir coluna `country` em LinkedUser.
      ...linkedProfiles.map((lp) => ({
        id: lp.id,
        firstName: lp.firstName,
        lastName: lp.lastName,
        email: lp.email,
        documentType: lp.documentType,
        documentNumber: lp.documentNumber,
        country: mainUser.country,
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

    const documentType =
      (dto.documentType as DocumentType | undefined) ??
      inferDocumentType(dto.documentNumber);
    const documentNumberClean = this.cleanDocumentNumber(dto.documentNumber, documentType);

    if (documentNumberClean) {
      const mainUser = await prismaRead.user.findUnique({
        where: { id: mainUserId },
        select: { documentType: true, documentNumberClean: true },
      });
      // Anti-self: só rejeita se TIPO + número coincidem com o próprio
      // usuário principal. Tipos distintos com mesmo numberClean por acaso
      // são tratados como documentos diferentes.
      if (
        mainUser?.documentNumberClean === documentNumberClean &&
        (mainUser.documentType ?? DocumentType.CPF) === documentType
      ) {
        throw new BadRequestException('Não é possível adicionar você mesmo como usuário vinculado');
      }

      const result = await prismaWrite.linkedUser.upsert({
        where: {
          mainUserId_documentType_documentNumberClean: {
            mainUserId,
            documentType,
            documentNumberClean,
          },
        },
        update: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email ?? null,
          phone: dto.phone,
          dateOfBirth,
          gender: dto.gender ?? null,
        },
        create: {
          mainUserId,
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email ?? null,
          documentType,
          // Mesma regra do register/patch: documentNumber sempre limpo.
          documentNumber: documentNumberClean,
          documentNumberClean,
          phone: dto.phone,
          dateOfBirth,
          gender: dto.gender ?? null,
          relationshipType: 'outro',
        },
      });
      return { success: true, data: this.formatLinkedProfile(result) };
    }

    const created = await prismaWrite.linkedUser.create({
      data: {
        mainUserId,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email ?? null,
        documentType: null,
        documentNumber: null,
        documentNumberClean: null,
        phone: dto.phone,
        dateOfBirth,
        gender: dto.gender ?? null,
        relationshipType: 'outro',
      },
    });

    return { success: true, data: this.formatLinkedProfile(created) };
  }

  async deleteLinkedUser(mainUserId: string, linkedUserId: string) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const linked = await prismaRead.linkedUser.findUnique({
      where: { id: linkedUserId },
      select: { id: true, mainUserId: true },
    });

    if (!linked || linked.mainUserId !== mainUserId) {
      throw new NotFoundException('Usuário vinculado não encontrado');
    }

    await prismaWrite.linkedUser.delete({ where: { id: linkedUserId } });

    return { success: true };
  }

  /**
   * Lookup de usuário por documento. Aceita CPF (formatado ou só dígitos)
   * E passaporte. O tipo é inferido pela heurística do util — 11 dígitos
   * puros → CPF; qualquer coisa com letras → PASSPORT.
   *
   * URL antiga `/by-cpf/:value` mantida por compat — endpoint generalizado
   * internamente (decisão da §12 do doc de internacionalização).
   */
  async findUserByCpf(value: string) {
    const prismaRead = this.prisma.getReadClient();
    const inferredType = inferDocumentType(value);
    const documentNumberClean = cleanDoc(value, inferredType);

    if (!documentNumberClean) {
      throw new NotFoundException('Usuário não encontrado');
    }

    const user = await prismaRead.user.findUnique({
      where: {
        documentNumberClean_accountType: { documentNumberClean, accountType: 'USER' },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        documentType: true,
        documentNumber: true,
        phone: true,
        dateOfBirth: true,
        gender: true,
        // Localização/nacionalidade — necessário pro pré-preenchimento do
        // formulário de participante estrangeiro (front decide UI por country).
        country: true,
        state: true,
        city: true,
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
    documentType?: DocumentType | null;
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
      documentType: lp.documentType ?? null,
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

