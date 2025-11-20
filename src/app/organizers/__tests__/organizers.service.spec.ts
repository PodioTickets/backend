import { Test, TestingModule } from '@nestjs/testing';
import { OrganizersService } from '../organizers.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmailService } from '../../../common/services/email.service';
import { WhatsAppService } from '../../../common/services/whatsapp.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('OrganizersService', () => {
  let service: OrganizersService;
  let prisma: PrismaService;
  let emailService: EmailService;
  let whatsappService: WhatsAppService;

  const mockPrismaService = {
    organizer: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    user: {
      update: jest.fn(),
    },
    contactMessage: {
      create: jest.fn(),
    },
  };

  const mockEmailService = {
    sendContactMessageToOrganizer: jest.fn(),
  };

  const mockWhatsAppService = {
    sendContactMessageToOrganizer: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizersService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: EmailService,
          useValue: mockEmailService,
        },
        {
          provide: WhatsAppService,
          useValue: mockWhatsAppService,
        },
      ],
    }).compile();

    service = module.get<OrganizersService>(OrganizersService);
    prisma = module.get<PrismaService>(PrismaService);
    emailService = module.get<EmailService>(EmailService);
    whatsappService = module.get<WhatsAppService>(WhatsAppService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create an organizer successfully', async () => {
      const userId = 'user-123';
      const createDto = {
        name: 'Test Organizer',
        email: 'test@example.com',
        phone: '1234567890',
      };

      const mockOrganizer = {
        id: 'org-123',
        userId,
        ...createDto,
        user: { id: userId },
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(null);
      mockPrismaService.organizer.create.mockResolvedValue(mockOrganizer);
      mockPrismaService.user.update.mockResolvedValue({ id: userId, role: 'ORGANIZER' });

      const result = await service.create(userId, createDto);

      expect(result.message).toBe('Organizer created successfully');
      expect(result.data.organizer).toEqual(mockOrganizer);
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { role: 'ORGANIZER' },
      });
    });

    it('should throw BadRequestException if user is already an organizer', async () => {
      const userId = 'user-123';
      mockPrismaService.organizer.findUnique.mockResolvedValue({ id: 'org-123' });

      await expect(
        service.create(userId, {
          name: 'Test',
          email: 'test@example.com',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findOne', () => {
    it('should return organizer by userId', async () => {
      const userId = 'user-123';
      const mockOrganizer = {
        id: 'org-123',
        userId,
        name: 'Test Organizer',
        events: [],
        user: { id: userId },
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);

      const result = await service.findOne(userId);

      expect(result.message).toBe('Organizer fetched successfully');
      expect(result.data.organizer).toEqual(mockOrganizer);
    });

    it('should throw NotFoundException if organizer not found', async () => {
      mockPrismaService.organizer.findUnique.mockResolvedValue(null);

      await expect(service.findOne('invalid-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update organizer successfully', async () => {
      const userId = 'user-123';
      const updateDto = { name: 'Updated Name' };
      const mockOrganizer = {
        id: 'org-123',
        userId,
        ...updateDto,
        user: { id: userId },
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue({ id: 'org-123' });
      mockPrismaService.organizer.update.mockResolvedValue(mockOrganizer);

      const result = await service.update(userId, updateDto);

      expect(result.message).toBe('Organizer updated successfully');
      expect(result.data.organizer).toEqual(mockOrganizer);
    });
  });

  describe('sendContactMessage', () => {
    it('should send contact message successfully', async () => {
      const organizerId = 'org-123';
      const contactData = {
        name: 'John Doe',
        email: 'john@example.com',
        message: 'Test message',
      };

      const mockOrganizer = {
        id: organizerId,
        email: 'organizer@example.com',
        name: 'Organizer',
        user: { phone: '1234567890' },
        events: [],
      };

      const mockContactMessage = {
        id: 'msg-123',
        organizerId,
        ...contactData,
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.contactMessage.create.mockResolvedValue(mockContactMessage);
      mockEmailService.sendContactMessageToOrganizer.mockResolvedValue(undefined);
      mockWhatsAppService.sendContactMessageToOrganizer.mockResolvedValue(undefined);

      const result = await service.sendContactMessage(organizerId, contactData);

      expect(result.message).toBe('Message sent successfully');
      expect(result.data.contactMessage).toEqual(mockContactMessage);
      expect(mockEmailService.sendContactMessageToOrganizer).toHaveBeenCalled();
    });

    it('should throw NotFoundException if organizer not found', async () => {
      mockPrismaService.organizer.findUnique.mockResolvedValue(null);

      await expect(
        service.sendContactMessage('invalid-id', {
          name: 'Test',
          email: 'test@example.com',
          message: 'Test',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});

