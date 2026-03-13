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
import * as crypto from 'crypto';

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
    
    // Se documentNumber foi atualizado, limpar e validar unicidade
    if (updateData.documentNumber !== undefined) {
      const documentNumberClean = this.cleanDocumentNumber(updateData.documentNumber);
      
      if (documentNumberClean) {
        const existingUser = await prismaRead.user.findFirst({
          where: {
            documentNumberClean: documentNumberClean,
            id: { not: id },
          },
        });

        if (existingUser) {
          throw new BadRequestException('This document number is already in use');
        }
      }
      
      // Adicionar documentNumberClean ao updateData
      updateData.documentNumberClean = documentNumberClean;
    }
    
    // Mapear emergencyPhone para reservePhone se fornecido
    if (updateData.emergencyPhone) {
      updateData.reservePhone = updateData.emergencyPhone;
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

  /**
   * Busca todos os usuários vinculados ao usuário principal (incluindo o próprio)
   */
  async getLinkedUsers(mainUserId: string) {
    const prismaRead = this.prisma.getReadClient();

    // Buscar usuário principal
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

    // Buscar usuários vinculados
    const linkedUsers = await prismaRead.linkedUser.findMany({
      where: { mainUserId },
      include: {
        linkedUser: {
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
        },
      },
    });

    // Montar lista de usuários
    const users = [
      {
        ...mainUser,
        isMainUser: true,
        dateOfBirth: mainUser.dateOfBirth
          ? mainUser.dateOfBirth.toISOString().split('T')[0]
          : null,
      },
      ...linkedUsers.map((lu) => ({
        ...lu.linkedUser,
        isMainUser: false,
        dateOfBirth: lu.linkedUser.dateOfBirth
          ? lu.linkedUser.dateOfBirth.toISOString().split('T')[0]
          : null,
      })),
    ];

    // Ordenar: principal primeiro, depois alfabeticamente
    users.sort((a, b) => {
      if (a.isMainUser) return -1;
      if (b.isMainUser) return 1;
      const nameA = `${a.firstName} ${a.lastName}`.toLowerCase();
      const nameB = `${b.firstName} ${b.lastName}`.toLowerCase();
      return nameA.localeCompare(nameB);
    });

    return {
      success: true,
      data: { users },
    };
  }

  /**
   * Cria ou vincula um usuário ao usuário principal
   */
  async createOrLinkUser(
    mainUserId: string,
    createLinkedUserDto: CreateLinkedUserDto,
  ) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Validar data de nascimento não é futura
    const dateOfBirth = new Date(createLinkedUserDto.dateOfBirth);
    if (dateOfBirth > new Date()) {
      throw new BadRequestException('Data de nascimento não pode ser futura');
    }

    const documentNumberClean = this.cleanDocumentNumber(createLinkedUserDto.documentNumber);
    let existingUser = await prismaRead.user.findUnique({
      where: { 
        documentNumberClean_accountType: {
          documentNumberClean: documentNumberClean,
          accountType: 'USER',
        }
      },
    });

    let wasCreated = false;
    let wasLinked = false;

    const EMAIL_JA_CADASTRADO = 'Já existe um usuário com esse email';

    if (!existingUser) {
      // Verificar no write para evitar atraso de réplica; se email já existe, tratar aqui
      const userWithEmail = await prismaWrite.user.findFirst({
        where: {
          email: createLinkedUserDto.email,
          accountType: 'USER',
        },
      });

      if (userWithEmail) {
        const onlyNameDiffers = this.onlyNameDiffersFromLinkedDto(
          userWithEmail,
          createLinkedUserDto,
          documentNumberClean,
          dateOfBirth,
        );
        if (onlyNameDiffers) {
          existingUser = await prismaWrite.user.update({
            where: { id: userWithEmail.id },
            data: {
              firstName: createLinkedUserDto.firstName,
              lastName: createLinkedUserDto.lastName,
            },
          });
        } else {
          throw new ConflictException(EMAIL_JA_CADASTRADO);
        }
      } else {
        // Criar novo usuário
        const randomPassword = crypto.randomBytes(32).toString('hex');
        const hashedPassword = await bcrypt.hash(randomPassword, 10);

        try {
          existingUser = await prismaWrite.user.create({
            data: {
              firstName: createLinkedUserDto.firstName,
              lastName: createLinkedUserDto.lastName,
              email: createLinkedUserDto.email,
              accountType: 'USER',
              documentNumber: createLinkedUserDto.documentNumber,
              documentNumberClean: documentNumberClean,
              phone: createLinkedUserDto.phone,
              dateOfBirth: dateOfBirth,
              gender: this.mapGenderToEnum(createLinkedUserDto.gender),
              password: hashedPassword,
              acceptedTerms: false,
              acceptedPrivacyPolicy: false,
            },
          });
          wasCreated = true;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const isUniqueConstraint =
            (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') ||
            msg.includes('Unique constraint failed');
          if (isUniqueConstraint) {
            const byEmail = await prismaWrite.user.findFirst({
              where: {
                email: createLinkedUserDto.email,
                accountType: 'USER',
              },
            });
            if (byEmail) {
              const onlyNameDiffers = this.onlyNameDiffersFromLinkedDto(
                byEmail,
                createLinkedUserDto,
                documentNumberClean,
                dateOfBirth,
              );
              if (onlyNameDiffers) {
                existingUser = await prismaWrite.user.update({
                  where: { id: byEmail.id },
                  data: {
                    firstName: createLinkedUserDto.firstName,
                    lastName: createLinkedUserDto.lastName,
                  },
                });
              } else {
                throw new ConflictException(EMAIL_JA_CADASTRADO);
              }
            } else {
              throw new ConflictException(EMAIL_JA_CADASTRADO);
            }
          } else {
            throw err;
          }
        }
      }
    } else {
      // Usuário encontrado por CPF: email deve ser o mesmo
      if (existingUser.email !== createLinkedUserDto.email) {
        throw new ConflictException(EMAIL_JA_CADASTRADO);
      }
    }

    // Verificar se já está vinculado
    const existingLink = await prismaRead.linkedUser.findUnique({
      where: {
        mainUserId_linkedUserId: {
          mainUserId,
          linkedUserId: existingUser.id,
        },
      },
    });

    if (!existingLink) {
      // Criar vínculo
      await prismaWrite.linkedUser.create({
        data: {
          mainUserId,
          linkedUserId: existingUser.id,
          relationshipType: 'outro',
        },
      });

      wasLinked = true;
    } else {
      wasLinked = true; // Já estava vinculado
    }

    return {
      success: true,
      data: {
        id: existingUser.id,
        firstName: existingUser.firstName,
        lastName: existingUser.lastName,
        email: existingUser.email,
        documentNumber: existingUser.documentNumber,
        phone: existingUser.phone,
        dateOfBirth: existingUser.dateOfBirth
          ? existingUser.dateOfBirth.toISOString().split('T')[0]
          : null,
        gender: this.mapGenderFromEnum(existingUser.gender),
        wasCreated,
        wasLinked,
      },
    };
  }

  /**
   * Verifica se o usuário existente difere do DTO apenas no nome (firstName/lastName).
   * Se documentNumber, phone, dateOfBirth ou gender forem diferentes, retorna false.
   */
  private onlyNameDiffersFromLinkedDto(
    existingUser: {
      documentNumberClean: string | null;
      phone: string | null;
      dateOfBirth: Date | null;
      gender: 'MALE' | 'FEMALE' | 'OTHER' | 'PREFER_NOT_TO_SAY' | null;
    },
    dto: CreateLinkedUserDto,
    documentNumberClean: string,
    dateOfBirth: Date,
  ): boolean {
    if ((existingUser.documentNumberClean ?? '') !== documentNumberClean) {
      return false;
    }
    if ((existingUser.phone ?? '') !== (dto.phone ?? '')) {
      return false;
    }
    const existingTime = existingUser.dateOfBirth
      ? existingUser.dateOfBirth.getTime()
      : 0;
    const dtoTime = dateOfBirth.getTime();
    if (existingTime !== dtoTime) {
      return false;
    }
    const dtoGender = this.mapGenderToEnum(dto.gender);
    if ((existingUser.gender ?? null) !== (dtoGender ?? null)) {
      return false;
    }
    return true;
  }

  /**
   * Mapeia gênero do DTO para enum do Prisma
   */
  private mapGenderToEnum(
    gender: string,
  ): 'MALE' | 'FEMALE' | 'OTHER' | 'PREFER_NOT_TO_SAY' | null {
    const mapping = {
      masculino: 'MALE' as const,
      feminino: 'FEMALE' as const,
      outro: 'OTHER' as const,
      'prefiro-nao-dizer': 'PREFER_NOT_TO_SAY' as const,
    };
    return mapping[gender.toLowerCase()] || null;
  }

  /**
   * Mapeia enum do Prisma para gênero do DTO
   */
  private mapGenderFromEnum(
    gender: 'MALE' | 'FEMALE' | 'OTHER' | 'PREFER_NOT_TO_SAY' | null,
  ): string {
    const mapping = {
      MALE: 'masculino',
      FEMALE: 'feminino',
      OTHER: 'outro',
      PREFER_NOT_TO_SAY: 'prefiro-nao-dizer',
    };
    return gender ? mapping[gender] : 'prefiro-nao-dizer';
  }
}

