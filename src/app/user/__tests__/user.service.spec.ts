import { Test, TestingModule } from '@nestjs/testing';
import { UserService } from '../user.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

describe('UserService', () => {
  let service: UserService;
  let prisma: PrismaService;

  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    getReadClient: jest.fn(),
    getWriteClient: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
    prisma = module.get<PrismaService>(PrismaService);

    // Mock getReadClient and getWriteClient to return the same mock
    mockPrismaService.getReadClient.mockReturnValue(mockPrismaService);
    mockPrismaService.getWriteClient.mockReturnValue(mockPrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    const createUserDto = {
      email: 'test@example.com',
      password: 'StrongPass123!',
      firstName: 'John',
      lastName: 'Doe',
      phone: '1234567890',
      documentNumber: '12345678901',
      acceptedTerms: true,
      acceptedPrivacyPolicy: true,
    };

    it('should create a user successfully', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockPrismaService.user.create.mockResolvedValue({
        id: 'user-id',
        email: createUserDto.email,
        firstName: createUserDto.firstName,
        lastName: createUserDto.lastName,
        phone: createUserDto.phone,
        documentNumber: createUserDto.documentNumber,
        role: 'USER',
        isActive: true,
      });

      const result = await service.create(createUserDto);

      expect(result).toHaveProperty('message', 'User created successfully');
      expect(result.data.user).toMatchObject({
        email: createUserDto.email,
        firstName: createUserDto.firstName,
        lastName: createUserDto.lastName,
      });
      expect(mockPrismaService.user.findUnique).toHaveBeenCalledTimes(2);
      expect(mockPrismaService.user.create).toHaveBeenCalled();
    });

    it('should throw BadRequestException if email already exists', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'existing-user-id',
        email: createUserDto.email,
      });

      await expect(service.create(createUserDto)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create(createUserDto)).rejects.toThrow(
        'User with this email already exists',
      );
    });

    it('should throw BadRequestException if documentNumber already exists', async () => {
      mockPrismaService.user.findUnique
        .mockResolvedValueOnce(null) // Email check
        .mockResolvedValueOnce({
          id: 'existing-user-id',
          documentNumber: createUserDto.documentNumber,
        });

      const error = await service.create(createUserDto).catch(e => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe('User with this document number already exists');
    });

    it('should throw BadRequestException for weak password', async () => {
      const weakPasswordDto = {
        ...createUserDto,
        password: 'weak',
      };

      await expect(service.create(weakPasswordDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for common password', async () => {
      const commonPasswordDto = {
        ...createUserDto,
        password: 'password123',
      };

      await expect(service.create(commonPasswordDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for sequential password', async () => {
      const sequentialPasswordDto = {
        ...createUserDto,
        password: 'abc123456',
      };

      await expect(service.create(sequentialPasswordDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should hash password before saving', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockPrismaService.user.create.mockResolvedValue({
        id: 'user-id',
        email: createUserDto.email,
        firstName: createUserDto.firstName,
        lastName: createUserDto.lastName,
        phone: createUserDto.phone,
        documentNumber: createUserDto.documentNumber,
        role: 'USER',
        isActive: true,
      });

      await service.create(createUserDto);

      const createCall = mockPrismaService.user.create.mock.calls[0][0];
      expect(createCall.data.password).toBeDefined();
      expect(createCall.data.password).not.toBe(createUserDto.password);
      expect(typeof createCall.data.password).toBe('string');
    });

    it('should handle dateOfBirth conversion', async () => {
      const dtoWithDate = {
        ...createUserDto,
        dateOfBirth: '2000-01-01',
      };

      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockPrismaService.user.create.mockResolvedValue({
        id: 'user-id',
        email: dtoWithDate.email,
      });

      await service.create(dtoWithDate);

      const createCall = mockPrismaService.user.create.mock.calls[0][0];
      expect(createCall.data.dateOfBirth).toBeInstanceOf(Date);
    });

    it('should allow creating user without password', async () => {
      const dtoWithoutPassword = {
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
        password: '',
        acceptedTerms: true,
        acceptedPrivacyPolicy: true,
      };

      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockPrismaService.user.create.mockResolvedValue({
        id: 'user-id',
        email: dtoWithoutPassword.email,
        firstName: dtoWithoutPassword.firstName,
        lastName: dtoWithoutPassword.lastName,
        role: 'USER',
        isActive: true,
      });

      const result = await service.create(dtoWithoutPassword);

      expect(result).toHaveProperty('message', 'User created successfully');
      const createCall = mockPrismaService.user.create.mock.calls[0][0];
      expect(createCall.data.password).toBe('');
    });
  });

  describe('findAll', () => {
    it('should return paginated users', async () => {
      const mockUsers = [
        {
          id: 'user-1',
          email: 'user1@example.com',
          firstName: 'User',
          lastName: 'One',
          phone: '1234567890',
          documentNumber: '12345678901',
          role: 'USER',
          isActive: true,
          createdAt: new Date(),
        },
        {
          id: 'user-2',
          email: 'user2@example.com',
          firstName: 'User',
          lastName: 'Two',
          phone: '0987654321',
          documentNumber: '10987654321',
          role: 'USER',
          isActive: true,
          createdAt: new Date(),
        },
      ];

      mockPrismaService.user.findMany.mockResolvedValue(mockUsers);

      const result = await service.findAll({ page: 1, limit: 50 });

      expect(result).toHaveProperty('message', 'Users fetched successfully');
      expect(result.data.users).toEqual(mockUsers);
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(50);
      expect(mockPrismaService.getReadClient).toHaveBeenCalled();
      expect(mockPrismaService.user.findMany).toHaveBeenCalledWith({
        skip: 0,
        take: 50,
        select: expect.any(Object),
      });
    });

    it('should use default pagination values', async () => {
      mockPrismaService.user.findMany.mockResolvedValue([]);

      await service.findAll();

      expect(mockPrismaService.user.findMany).toHaveBeenCalledWith({
        skip: 0,
        take: 50,
        select: expect.any(Object),
      });
    });

    it('should handle custom pagination', async () => {
      mockPrismaService.user.findMany.mockResolvedValue([]);

      await service.findAll({ page: 2, limit: 10 });

      expect(mockPrismaService.user.findMany).toHaveBeenCalledWith({
        skip: 10,
        take: 10,
        select: expect.any(Object),
      });
    });
  });

  describe('findOne', () => {
    const userId = 'user-id';
    const mockUser = {
      id: userId,
      email: 'test@example.com',
      firstName: 'John',
      lastName: 'Doe',
      gender: 'MALE',
      phone: '1234567890',
      dateOfBirth: new Date('2000-01-01'),
      country: 'BR',
      state: 'SP',
      city: 'São Paulo',
      documentType: 'CPF',
      documentNumber: '12345678901',
      sex: 'MALE',
      acceptedTerms: true,
      acceptedPrivacyPolicy: true,
      receiveCalendarEvents: false,
      receivePartnerPromos: false,
      language: 'PT',
      role: 'USER',
      isActive: true,
    };

    it('should return user by id', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);

      const result = await service.findOne(userId);

      expect(result).toHaveProperty('message', 'User fetched successfully');
      expect(result.data.user).toEqual(mockUser);
      expect(mockPrismaService.getReadClient).toHaveBeenCalled();
      expect(mockPrismaService.user.findUnique).toHaveBeenCalledWith({
        where: { id: userId },
        select: expect.any(Object),
      });
    });

    it('should throw NotFoundException if user does not exist', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      await expect(service.findOne(userId)).rejects.toThrow(NotFoundException);
      await expect(service.findOne(userId)).rejects.toThrow('User not found');
    });
  });

  describe('update', () => {
    const userId = 'user-id';
    const updateUserDto = {
      firstName: 'Jane',
      lastName: 'Smith',
      phone: '9876543210',
    };

    it('should update user successfully', async () => {
      const mockUpdatedUser = {
        id: userId,
        email: 'test@example.com',
        firstName: updateUserDto.firstName,
        lastName: updateUserDto.lastName,
        phone: updateUserDto.phone,
        documentNumber: '12345678901',
        role: 'USER',
        isActive: true,
      };

      mockPrismaService.user.findFirst.mockResolvedValue(null);
      mockPrismaService.user.update.mockResolvedValue(mockUpdatedUser);

      const result = await service.update(userId, updateUserDto);

      expect(result).toHaveProperty('message', 'User updated successfully');
      expect(result.data.user).toEqual(mockUpdatedUser);
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: updateUserDto,
        select: expect.any(Object),
      });
    });

    it('should hash password if provided', async () => {
      const dtoWithPassword = {
        ...updateUserDto,
        password: 'NewStrongPass123!',
      };

      // Mock bcrypt.hash to return a different hash
      jest.spyOn(bcrypt, 'hash').mockImplementation(() => Promise.resolve('hashed-password'));

      mockPrismaService.user.findFirst.mockResolvedValue(null);
      mockPrismaService.user.update.mockResolvedValue({
        id: userId,
        email: 'test@example.com',
        firstName: updateUserDto.firstName,
      });

      await service.update(userId, dtoWithPassword);

      const updateCall = mockPrismaService.user.update.mock.calls[0][0];
      expect(updateCall.data.password).toBeDefined();
      expect(updateCall.data.password).toBe('hashed-password');
      // Verify that the password was hashed (should be different from original)
      expect(updateCall.data.password).not.toBe('NewStrongPass123!');
      expect(bcrypt.hash).toHaveBeenCalledWith('NewStrongPass123!', 12);
    });

    it('should validate password strength when updating', async () => {
      const weakPasswordDto = {
        password: 'weak',
      };

      await expect(service.update(userId, weakPasswordDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if documentNumber is already in use', async () => {
      const dtoWithDocument = {
        ...updateUserDto,
        documentNumber: '12345678901',
      };

      mockPrismaService.user.findFirst.mockResolvedValue({
        id: 'other-user-id',
        documentNumber: dtoWithDocument.documentNumber,
      });

      await expect(service.update(userId, dtoWithDocument)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.update(userId, dtoWithDocument)).rejects.toThrow(
        'This document number is already in use',
      );
    });

    it('should handle dateOfBirth conversion', async () => {
      const dtoWithDate = {
        ...updateUserDto,
        dateOfBirth: '2000-01-01',
      };

      mockPrismaService.user.findFirst.mockResolvedValue(null);
      mockPrismaService.user.update.mockResolvedValue({
        id: userId,
        email: 'test@example.com',
      });

      await service.update(userId, dtoWithDate);

      const updateCall = mockPrismaService.user.update.mock.calls[0][0];
      expect(updateCall.data.dateOfBirth).toBeInstanceOf(Date);
    });
  });

  describe('remove', () => {
    const userId = 'user-id';

    it('should delete user successfully', async () => {
      mockPrismaService.user.delete.mockResolvedValue({ id: userId });

      const result = await service.remove(userId);

      expect(result).toHaveProperty('message', 'User removed successfully');
      expect(mockPrismaService.user.delete).toHaveBeenCalledWith({
        where: { id: userId },
      });
    });
  });

  describe('validatePasswordStrength', () => {
    it('should accept valid strong password', () => {
      expect(() => {
        const service = new UserService(mockPrismaService as any);
        (service as any).validatePasswordStrength('StrongPass123!');
      }).not.toThrow();
    });

    it('should reject password without uppercase', () => {
      expect(() => {
        const service = new UserService(mockPrismaService as any);
        (service as any).validatePasswordStrength('lowercase123!');
      }).toThrow(BadRequestException);
    });

    it('should reject password without lowercase', () => {
      expect(() => {
        const service = new UserService(mockPrismaService as any);
        (service as any).validatePasswordStrength('UPPERCASE123!');
      }).toThrow(BadRequestException);
    });

    it('should reject password without digit', () => {
      expect(() => {
        const service = new UserService(mockPrismaService as any);
        (service as any).validatePasswordStrength('NoDigitsPass!');
      }).toThrow(BadRequestException);
    });

    it('should reject password without special character', () => {
      expect(() => {
        const service = new UserService(mockPrismaService as any);
        (service as any).validatePasswordStrength('NoSpecial123');
      }).toThrow(BadRequestException);
    });

    it('should reject password shorter than 8 characters', () => {
      expect(() => {
        const service = new UserService(mockPrismaService as any);
        (service as any).validatePasswordStrength('Short1!');
      }).toThrow(BadRequestException);
    });
  });
});

