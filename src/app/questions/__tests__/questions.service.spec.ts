import { Test, TestingModule } from '@nestjs/testing';
import { QuestionsService } from '../questions.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrganizationAuditService } from '../../../common/services/organization-audit.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('QuestionsService', () => {
  let service: QuestionsService;
  let prisma: PrismaService;

  const mockPrismaService = {
    organizer: {
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    event: {
      findUnique: jest.fn(),
    },
    question: {
      create: jest.fn(),
      findUnique: jest.fn(),
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
        QuestionsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: OrganizationAuditService,
          useValue: { record: jest.fn(), recordForEvent: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<QuestionsService>(QuestionsService);
    prisma = module.get<PrismaService>(PrismaService);

    // Mock getReadClient and getWriteClient to return the same mock
    mockPrismaService.getReadClient.mockReturnValue(mockPrismaService);
    mockPrismaService.getWriteClient.mockReturnValue(mockPrismaService);
    // role ADMIN → verifyOrganizerAccess (que lê user.findUnique) dá bypass
    mockPrismaService.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a question successfully', async () => {
      const userId = 'user-123';
      const eventId = 'event-123';
      const createDto = {
        question: 'What is your t-shirt size?',
        type: 'select',
        options: ['S', 'M', 'L'],
        isRequired: true,
      };

      const mockOrganizer = { id: 'org-123', userId };
      const mockEvent = { id: eventId, organizerId: mockOrganizer.id };
      const mockQuestion = {
        id: 'question-123',
        eventId,
        ...createDto,
        appliesTo: null, // o service transforma appliesTo na resposta
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.question.create.mockResolvedValue(mockQuestion);

      const result = await service.create(userId, eventId, createDto);

      expect(result.message).toBe('Question created successfully');
      expect(result.data.question).toEqual(mockQuestion);
    });
  });

  describe('findAll', () => {
    it('should return all questions for an event', async () => {
      const eventId = 'event-123';
      const mockQuestions = [
        {
          id: 'question-123',
          eventId,
          question: 'Test Question',
          type: 'text',
          isRequired: false,
          appliesTo: null,
        },
      ];

      mockPrismaService.question.findMany.mockResolvedValue(mockQuestions);

      const result = await service.findAll(eventId);

      expect(result.message).toBe('Questions fetched successfully');
      expect(result.data.questions).toEqual(mockQuestions);
    });
  });

  describe('findOne', () => {
    it('should return a question by id', async () => {
      const questionId = 'question-123';
      const mockQuestion = {
        id: questionId,
        question: 'Test Question',
        type: 'text',
        event: { id: 'event-123', name: 'Test Event' },
        appliesTo: null,
      };

      mockPrismaService.question.findUnique.mockResolvedValue(mockQuestion);

      const result = await service.findOne(questionId);

      expect(result.message).toBe('Question fetched successfully');
      expect(result.data.question).toEqual(mockQuestion);
    });

    it('should throw NotFoundException if question not found', async () => {
      mockPrismaService.question.findUnique.mockResolvedValue(null);

      await expect(service.findOne('invalid-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update a question successfully', async () => {
      const userId = 'user-123';
      const eventId = 'event-123';
      const questionId = 'question-123';
      const updateDto = { question: 'Updated Question' };

      const mockOrganizer = { id: 'org-123', userId };
      const mockEvent = { id: eventId, organizerId: mockOrganizer.id };
      const mockQuestion = {
        id: questionId,
        eventId,
        isActive: true, // update exige a pergunta ativa
        ...updateDto,
        appliesTo: null,
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.question.findUnique.mockResolvedValue(mockQuestion);
      mockPrismaService.question.update.mockResolvedValue(mockQuestion);

      const result = await service.update(userId, eventId, questionId, updateDto);

      expect(result.message).toBe('Question updated successfully');
      expect(result.data.question).toEqual(mockQuestion);
    });
  });

  describe('remove', () => {
    it('should remove a question successfully', async () => {
      const userId = 'user-123';
      const eventId = 'event-123';
      const questionId = 'question-123';

      const mockOrganizer = { id: 'org-123', userId };
      const mockEvent = { id: eventId, organizerId: mockOrganizer.id };
      const mockQuestion = {
        id: questionId,
        eventId,
        isActive: true,
        answers: [],
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.question.findUnique.mockResolvedValue(mockQuestion);
      mockPrismaService.question.delete.mockResolvedValue(mockQuestion);

      const result = await service.remove(userId, eventId, questionId);

      expect(result.message).toBe('Question deleted successfully');
    });

    it('should SOFT-delete (isActive=false) when question has answers', async () => {
      // Comportamento atual: pergunta com respostas é desativada (mantém histórico),
      // não deletada nem rejeitada.
      const mockOrganizer = { id: 'org-123', userId: 'user-123' };
      const mockEvent = { id: 'event-123', organizerId: mockOrganizer.id };
      const mockQuestion = {
        id: 'question-123',
        eventId: 'event-123',
        isActive: true,
        answers: [{ id: 'answer-123' }],
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.question.findUnique.mockResolvedValue(mockQuestion);
      mockPrismaService.question.update.mockResolvedValue({ ...mockQuestion, isActive: false });

      const result = await service.remove('user-123', 'event-123', 'question-123');

      expect(result.message).toBe('Question deleted successfully');
      expect(mockPrismaService.question.update).toHaveBeenCalledWith({
        where: { id: 'question-123' },
        data: { isActive: false },
      });
      expect(mockPrismaService.question.delete).not.toHaveBeenCalled();
    });
  });
});

