import { Test, TestingModule } from '@nestjs/testing';
import { OrganizersService } from '../organizers.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmailService } from '../../../common/services/email.service';
import { WhatsAppService } from '../../../common/services/whatsapp.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('OrganizersService - Comprehensive Tests', () => {
  let service: OrganizersService;
  let prisma: PrismaService;
  let emailService: EmailService;
  let whatsappService: WhatsAppService;

  // Modelo organização + membro (OWNER), acessado via getReadClient()/getWriteClient().
  // $transaction roda o callback com o próprio mock como cliente tx.
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
      findMany: jest.fn(),
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

  // Helper: monta uma organização com um membro OWNER (com telefone) para o
  // fluxo de mensagem de contato (e-mail + WhatsApp do dono).
  const buildOrganizationWithOwner = (organizationId = 'org-123') => ({
    id: organizationId,
    name: 'Test Organizer',
    email: 'org@example.com',
    logoUrl: null,
    members: [{ user: { email: 'org@example.com', phone: '11999999999' } }],
    events: [],
  });

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
    mockPrismaService.$transaction.mockImplementation((cb: any) => cb(mockPrismaService));
    // userId no contato dispara busca do user; default não encontra nada.
    mockPrismaService.user.findUnique.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Use Cases - User Flow', () => {
    describe('UC1: User becomes organizer', () => {
      it('should create organizer profile and update user role', async () => {
        const userId = 'user-123';
        const createDto = {
          name: 'Maratona SP',
          email: 'org@example.com',
          phone: '11999999999',
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

        expect(result.data.organization).toBeDefined();
        expect(result.data.member).toBeDefined();
        expect(mockPrismaService.user.update).toHaveBeenCalledWith({
          where: { id: userId },
          data: { role: 'ORGANIZER', accountType: 'ORGANIZER' },
        });
      });

      it('should prevent duplicate organizer creation', async () => {
        const userId = 'user-123';

        mockPrismaService.organizationMember.findFirst.mockResolvedValue({ id: 'member-123', role: 'OWNER' });

        await expect(
          service.create(userId, {
            name: 'Test',
            email: 'test@example.com',
            phone: '11999999999',
          }),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('UC2: User contacts organizer', () => {
      it('should send email and WhatsApp message', async () => {
        const userId = 'user-123';
        const organizationId = 'org-123';
        const contactData = {
          name: 'John Doe',
          email: 'user@example.com',
          phone: '11999999999',
          message: 'I have a question',
          userId,
        };

        mockPrismaService.organization.findUnique.mockResolvedValue(buildOrganizationWithOwner(organizationId));
        mockPrismaService.contactMessage.create.mockResolvedValue({ id: 'msg-123', organizationId, ...contactData });

        const result = await service.sendContactMessage(organizationId, contactData);

        expect(mockEmailService.sendContactMessageToOrganizer).toHaveBeenCalled();
        expect(result.message).toContain('Message sent successfully');
      });

      it('should handle WhatsApp contact method', async () => {
        const userId = 'user-123';
        const organizationId = 'org-123';
        const contactData = {
          name: 'John Doe',
          email: 'user@example.com',
          phone: '11999999999',
          message: 'Hello',
          userId,
        };

        mockPrismaService.organization.findUnique.mockResolvedValue(buildOrganizationWithOwner(organizationId));
        mockPrismaService.contactMessage.create.mockResolvedValue({ id: 'msg-123', organizationId, ...contactData });

        await service.sendContactMessage(organizationId, contactData);

        // WhatsApp dispara apenas porque o membro OWNER tem telefone cadastrado.
        expect(mockWhatsAppService.sendContactMessageToOrganizer).toHaveBeenCalled();
      });
    });
  });

  describe('Security Tests', () => {
    describe('Authorization', () => {
      it('should prevent contacting non-existent organizer', async () => {
        const organizationId = 'non-existent-org';
        const contactData = {
          name: 'Test User',
          email: 'test@example.com',
          message: 'Test',
        };

        mockPrismaService.organization.findUnique.mockResolvedValue(null);

        await expect(
          service.sendContactMessage(organizationId, contactData),
        ).rejects.toThrow(NotFoundException);
      });

      it('should prevent unauthorized contact message access', async () => {
        const organizationId = 'org-123';
        const contactData = {
          name: 'Test User',
          email: 'test@example.com',
          message: 'Test',
        };

        mockPrismaService.organization.findUnique.mockResolvedValue(null);

        await expect(
          service.sendContactMessage(organizationId, contactData),
        ).rejects.toThrow(NotFoundException);
      });
    });

    describe('Input Validation', () => {
      it('should propagate create errors (invalid email)', async () => {
        const userId = 'user-123';
        const invalidEmails = ['invalid', '@example.com', 'test@', 'test@.com'];

        // O service não valida e-mail (responsabilidade do DTO/Prisma). Simulamos a
        // rejeição do create para garantir que o erro propaga sem ser engolido.
        for (const email of invalidEmails) {
          mockPrismaService.organizationMember.findFirst.mockResolvedValue(null);
          const prismaError = new Error('Invalid email format');
          (prismaError as any).code = 'P2003';
          mockPrismaService.organization.create.mockRejectedValue(prismaError);

          await expect(
            service.create(userId, {
              name: 'Test',
              email,
              phone: '11999999999',
            }),
          ).rejects.toThrow();
        }
      });

      it('should sanitize links in contact message', async () => {
        const userId = 'user-123';
        const organizationId = 'org-123';
        // O service sanitiza links/domínios da mensagem antes de persistir.
        const messageWithLink = 'Visite https://spam.com agora mesmo';

        mockPrismaService.organization.findUnique.mockResolvedValue(buildOrganizationWithOwner(organizationId));
        mockPrismaService.contactMessage.create.mockResolvedValue({ id: 'msg-123' });

        await service.sendContactMessage(organizationId, {
          name: 'Test User',
          email: 'test@example.com',
          message: messageWithLink,
          userId,
        });

        expect(mockPrismaService.contactMessage.create).toHaveBeenCalled();
        const savedMessage = mockPrismaService.contactMessage.create.mock.calls[0][0].data.message;
        // O link foi removido pela sanitização.
        expect(savedMessage).not.toContain('https://spam.com');
      });
    });

    describe('Rate Limiting', () => {
      it('should handle multiple contact messages efficiently', async () => {
        const userId = 'user-123';
        const organizationId = 'org-123';

        mockPrismaService.organization.findUnique.mockResolvedValue(buildOrganizationWithOwner(organizationId));
        mockPrismaService.contactMessage.create.mockResolvedValue({ id: 'msg-123' });

        const startTime = Date.now();
        const promises = Array.from({ length: 10 }, (_, i) =>
          service.sendContactMessage(organizationId, {
            name: `Test User ${i}`,
            email: `test${i}@example.com`,
            message: `Message ${i}`,
            userId,
          }),
        );

        await Promise.all(promises);
        const endTime = Date.now();

        expect(endTime - startTime).toBeLessThan(2000);
        expect(mockEmailService.sendContactMessageToOrganizer).toHaveBeenCalledTimes(10);
      });
    });
  });

  describe('Performance Tests', () => {
    it('should load organizer with events efficiently', async () => {
      const userId = 'org-user-123';
      const mockOrganization = {
        id: 'org-123',
        name: 'Test Organizer',
        email: 'org@example.com',
        members: [],
        events: Array.from({ length: 100 }, (_, i) => ({
          id: `event-${i}`,
          name: `Event ${i}`,
          createdAt: new Date(),
          _count: { registrations: Math.floor(Math.random() * 100) },
        })),
      };

      mockPrismaService.organizationMember.findFirst.mockResolvedValue({
        id: 'member-123',
        userId,
        role: 'OWNER',
        organization: mockOrganization,
        user: { id: userId },
      });

      const startTime = Date.now();
      const result = await service.findOne(userId);
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(1000);
      expect(result.data.organization.events).toHaveLength(100);
    });
  });

  describe('Edge Cases', () => {
    it('should handle organizer update with partial data', async () => {
      const userId = 'org-user-123';
      const updateDto = { name: 'Updated Name' };

      mockPrismaService.organizationMember.findFirst.mockResolvedValue({
        id: 'member-123',
        organizationId: 'org-123',
        role: 'OWNER',
        organization: { id: 'org-123' },
      });
      mockPrismaService.organization.update.mockResolvedValue({
        id: 'org-123',
        name: 'Updated Name',
        email: 'org@example.com',
        members: [],
      });

      const result = await service.update(userId, updateDto);

      expect(result.data.organization.name).toBe(updateDto.name);
      expect(result.data.organization.email).toBe('org@example.com');
    });

    it('should handle contact message with very long text', async () => {
      const userId = 'user-123';
      const organizationId = 'org-123';
      const longMessage = 'A'.repeat(10000);

      mockPrismaService.organization.findUnique.mockResolvedValue(buildOrganizationWithOwner(organizationId));
      mockPrismaService.contactMessage.create.mockResolvedValue({ id: 'msg-123', message: longMessage });

      await expect(
        service.sendContactMessage(organizationId, {
          name: 'Test User',
          email: 'test@example.com',
          message: longMessage,
          userId,
        }),
      ).resolves.toBeDefined();
    });

    it('should handle special characters in organizer name', async () => {
      const userId = 'user-123';
      const createDto = {
        name: "Organizador Especial: 2025! @#$%^&*()_+-=[]{}|;':\",./<>?",
        email: 'org@example.com',
        phone: '11999999999',
      };

      const mockOrganization = { id: 'org-123', ...createDto };
      mockPrismaService.organizationMember.findFirst.mockResolvedValue(null);
      mockPrismaService.organization.create.mockResolvedValue(mockOrganization);
      mockPrismaService.organizationMember.create.mockResolvedValue({
        id: 'member-123',
        userId,
        role: 'OWNER',
        organization: mockOrganization,
        user: { id: userId, firstName: 'John', email: 'user@example.com' },
      });
      mockPrismaService.user.update.mockResolvedValue({ id: userId, role: 'ORGANIZER', accountType: 'ORGANIZER' });

      const result = await service.create(userId, createDto);

      expect(result.data.organization.name).toBe(createDto.name);
    });
  });

  describe('Data Integrity', () => {
    it('should fail creation when transactional user update fails', async () => {
      const userId = 'user-123';
      const createDto = {
        name: 'Test Organizer',
        email: 'org@example.com',
        phone: '11999999999',
      };

      mockPrismaService.organizationMember.findFirst.mockResolvedValue(null);
      mockPrismaService.organization.create.mockResolvedValue({ id: 'org-123', ...createDto });
      mockPrismaService.organizationMember.create.mockResolvedValue({
        id: 'member-123',
        userId,
        role: 'OWNER',
        organization: { id: 'org-123' },
        user: { id: userId, email: 'user@example.com' },
      });
      // Falha no update do user dentro da transação → toda a operação rejeita.
      mockPrismaService.user.update.mockRejectedValue(new Error('User not found'));

      await expect(service.create(userId, createDto)).rejects.toThrow();
      expect(mockPrismaService.organization.create).toHaveBeenCalled();
    });

    it('should propagate unique constraint errors on creation', async () => {
      const userId = 'user-123';
      const createDto = {
        name: 'Test',
        email: 'duplicate@example.com',
        phone: '11999999999',
      };

      mockPrismaService.organizationMember.findFirst.mockResolvedValue(null);
      const prismaError = new Error('Unique constraint failed');
      (prismaError as any).code = 'P2002';
      (prismaError as any).meta = { target: ['email'] };
      mockPrismaService.organization.create.mockRejectedValue(prismaError);

      await expect(service.create(userId, createDto)).rejects.toThrow();
    });
  });
});
