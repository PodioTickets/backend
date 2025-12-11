import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  private validatePasswordStrength(password: string): void {
    // Requisitos de senha forte:
    // - Pelo menos 8 caracteres
    // - Pelo menos uma letra minúscula
    // - Pelo menos uma letra maiúscula
    // - Pelo menos um dígito
    // - Pelo menos um caractere especial
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

    // Verificar se email já existe
    const existingUserByEmail = await prismaRead.user.findUnique({
      where: { email: createUserDto.email },
    });

    if (existingUserByEmail) {
      throw new ConflictException('User with this email already exists');
    }

    // Verificar se CPF já existe (se fornecido)
    if (createUserDto.documentNumber) {
      const existingUserByCpf = await prismaRead.user.findUnique({
        where: { documentNumber: createUserDto.documentNumber },
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
        dateOfBirth: true,
        country: true,
        state: true,
        city: true,
        documentType: true,
        documentNumber: true,
        sex: true,
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

    if (updateUserDto.documentNumber) {
      const existingUser = await prismaRead.user.findFirst({
        where: {
          documentNumber: updateUserDto.documentNumber,
          id: { not: id },
        },
      });

      if (existingUser) {
        throw new BadRequestException('This document number is already in use');
      }
    }

    const updateData: any = { ...updateUserDto };
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
}

