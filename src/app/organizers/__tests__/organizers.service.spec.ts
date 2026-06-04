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

  // O service trabalha com o modelo organização + membro (role OWNER), via
  // getReadClient()/getWriteClient(). O mock expõe os models usados e um
  // $transaction que executa o callback passando o próprio mock como tx.
  const mockPrismaService = {
    organizationMember: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    organization: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    user: {
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    contactMessage: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
    getReadClient: jest.fn(),
    getWriteClient: jest.fn(),
  };

  const mockEmailService = {
    sendWelcomeOrganizer: jest.fn().mockResolvedValue(undefined),
    sendContactMessageToOrganizer: jest.fn().mockResolvedValue(undefined),
    sendContactMessageConfirmation: jest.fn().mockResolvedValue(undefined),
  };

  const mockWhatsAppService = {
    sendContactMessageToOrganizer: jest.fn().mockResolvedValue(undefined),
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

    mockPrismaService.getReadClient.mockReturnValue(mockPrismaService);
    mockPrismaService.getWriteClient.mockReturnValue(mockPrismaService);
    // $transaction executa o callback com o próprio mock como cliente tx.
    mockPrismaService.$transaction.mockImplementation((cb: any) => cb(mockPrismaService));
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

      const mockOrganization = { id: 'org-123', ...createDto };
      const mockMember = {
        id: 'member-123',
        organizationId: 'org-123',
        userId,
        role: 'OWNER',
        user: { id: userId, firstName: 'John', lastName: 'Doe', email: 'user@example.com' },
        organization: mockOrganization,
      };

      mockPrismaService.organizationMember.findFirst.mockResolvedValue(null);
      mockPrismaService.organization.create.mockResolvedValue(mockOrganization);
      mockPrismaService.organizationMember.create.mockResolvedValue(mockMember);
      mockPrismaService.user.update.mockResolvedValue({ id: userId, role: 'ORGANIZER', accountType: 'ORGANIZER' });

      const result = await service.create(userId, createDto);

      expect(result.message).toBe('Organizer created successfully');
      expect(result.data.organization).toEqual(mockOrganization);
      expect(result.data.member).toEqual(mockMember);
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: userId },
        data: { role: 'ORGANIZER', accountType: 'ORGANIZER' },
      });
    });

    it('should throw BadRequestException if user is already an organizer', async () => {
      const userId = 'user-123';
      mockPrismaService.organizationMember.findFirst.mockResolvedValue({ id: 'member-123', role: 'OWNER' });

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
      const mockOrganization = { id: 'org-123', name: 'Test Organizer', members: [], events: [] };
      const mockMember = {
        id: 'member-123',
        userId,
        role: 'OWNER',
        organization: mockOrganization,
        user: { id: userId },
      };

      mockPrismaService.organizationMember.findFirst.mockResolvedValue(mockMember);

      const result = await service.findOne(userId);

      expect(result.message).toBe('Organizer fetched successfully');
      expect(result.data.organization).toEqual(mockOrganization);
      expect(result.data.member).toEqual(mockMember);
    });

    it('should throw NotFoundException if organizer not found', async () => {
      mockPrismaService.organizationMember.findFirst.mockResolvedValue(null);

      await expect(service.findOne('invalid-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update organizer successfully', async () => {
      const userId = 'user-123';
      const updateDto = { name: 'Updated Name' };
      const mockOrganization = { id: 'org-123', name: 'Updated Name', members: [] };

      mockPrismaService.organizationMember.findFirst.mockResolvedValue({
        id: 'member-123',
        organizationId: 'org-123',
        role: 'OWNER',
        organization: { id: 'org-123' },
      });
      mockPrismaService.organization.update.mockResolvedValue(mockOrganization);

      const result = await service.update(userId, updateDto);

      expect(result.message).toBe('Organizer updated successfully');
      expect(result.data.organization).toEqual(mockOrganization);
    });
  });

  describe('sendContactMessage', () => {
    it('should send contact message successfully', async () => {
      const organizationId = 'org-123';
      const contactData = {
        name: 'John Doe',
        email: 'john@example.com',
        message: 'Test message',
      };

      const mockOrganization = {
        id: organizationId,
        email: 'organizer@example.com',
        name: 'Organizer',
        logoUrl: null,
        members: [{ user: { email: 'organizer@example.com', phone: '1234567890' } }],
        events: [],
      };

      const mockContactMessage = { id: 'msg-123', organizationId, ...contactData };

      mockPrismaService.organization.findUnique.mockResolvedValue(mockOrganization);
      mockPrismaService.contactMessage.create.mockResolvedValue(mockContactMessage);

      const result = await service.sendContactMessage(organizationId, contactData);

      expect(result.message).toBe('Message sent successfully');
      expect(result.data.contactMessage).toEqual(mockContactMessage);
      expect(mockEmailService.sendContactMessageToOrganizer).toHaveBeenCalled();
    });

    it('should throw NotFoundException if organizer not found', async () => {
      mockPrismaService.organization.findUnique.mockResolvedValue(null);

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
