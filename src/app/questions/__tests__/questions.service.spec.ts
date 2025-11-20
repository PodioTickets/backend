import { Test, TestingModule } from '@nestjs/testing';
import { QuestionsService } from '../questions.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('QuestionsService', () => {
  let service: QuestionsService;
  let prisma: PrismaService;

  const mockPrismaService = {
    organizer: {
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
      ],
    }).compile();

    service = module.get<QuestionsService>(QuestionsService);
    prisma = module.get<PrismaService>(PrismaService);

    // Mock getReadClient and getWriteClient to return the same mock
    mockPrismaService.getReadClient.mockReturnValue(mockPrismaService);
    mockPrismaService.getWriteClient.mockReturnValue(mockPrismaService);
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
        ...updateDto,
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
        answers: [],
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.question.findUnique.mockResolvedValue(mockQuestion);
      mockPrismaService.question.delete.mockResolvedValue(mockQuestion);

      const result = await service.remove(userId, eventId, questionId);

      expect(result.message).toBe('Question deleted successfully');
    });

    it('should throw BadRequestException if question has answers', async () => {
      const mockOrganizer = { id: 'org-123', userId: 'user-123' };
      const mockEvent = { id: 'event-123', organizerId: mockOrganizer.id };
      const mockQuestion = {
        id: 'question-123',
        eventId: 'event-123',
        answers: [{ id: 'answer-123' }],
      };

      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.question.findUnique.mockResolvedValue(mockQuestion);

      await expect(
        service.remove('user-123', 'event-123', 'question-123'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});

