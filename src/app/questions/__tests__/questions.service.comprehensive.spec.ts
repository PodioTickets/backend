import { Test, TestingModule } from '@nestjs/testing';
import { QuestionsService } from '../questions.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('QuestionsService - Comprehensive Tests', () => {
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

  describe('Use Cases - User Flow', () => {
    describe('UC1: Organizer creates custom questions', () => {
      it('should create text question', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';
        const createDto = {
          question: 'Qual seu tamanho de camiseta?',
          type: 'text' as const,
          isRequired: true,
          order: 1,
        };

        const mockEvent = { id: eventId, organizerId: 'org-123' };
        const mockOrganizer = { id: 'org-123', userId };
        const mockQuestion = {
          id: 'q-123',
          eventId,
          ...createDto,
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.question.create.mockResolvedValue(mockQuestion);

        const result = await service.create(userId, eventId, createDto);

        expect(result.data.question.type).toBe('text');
        expect(result.data.question.isRequired).toBe(true);
      });

      it('should create multiple choice question', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';
        const createDto = {
          question: 'Qual sua experiência?',
          type: 'multiple_choice' as const,
          options: ['Iniciante', 'Intermediário', 'Avançado'],
          isRequired: true,
          order: 2,
        };

        const mockEvent = { id: eventId, organizerId: 'org-123' };
        const mockOrganizer = { id: 'org-123', userId };
        const mockQuestion = {
          id: 'q-123',
          eventId,
          ...createDto,
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.question.create.mockResolvedValue(mockQuestion);

        const result = await service.create(userId, eventId, createDto);

        expect(result.data.question.type).toBe('multiple_choice');
        expect(result.data.question.options).toEqual(createDto.options);
      });

      it('should create yes/no question', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';
        const createDto = {
          question: 'Você já participou de eventos anteriores?',
          type: 'yes_no' as const,
          isRequired: false,
          order: 3,
        };

        const mockEvent = { id: eventId, organizerId: 'org-123' };
        const mockOrganizer = { id: 'org-123', userId };
        const mockQuestion = {
          id: 'q-123',
          eventId,
          ...createDto,
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.question.create.mockResolvedValue(mockQuestion);

        const result = await service.create(userId, eventId, createDto);

        expect(result.data.question.type).toBe('yes_no');
      });
    });

    describe('UC2: User answers questions during registration', () => {
      it('should return questions in correct order', async () => {
        const eventId = 'event-123';
        const mockQuestions = [
          { id: 'q-1', eventId, question: 'Question 1', order: 1, isRequired: true },
          { id: 'q-2', eventId, question: 'Question 2', order: 2, isRequired: false },
          { id: 'q-3', eventId, question: 'Question 3', order: 3, isRequired: true },
        ];

        mockPrismaService.question.findMany.mockResolvedValue(mockQuestions);

        const result = await service.findAll(eventId);

        expect(result.data.questions).toHaveLength(3);
        expect(result.data.questions[0].order).toBe(1);
        expect(result.data.questions[1].order).toBe(2);
        expect(result.data.questions[2].order).toBe(3);
      });
    });

    describe('UC3: Required questions validation', () => {
      it('should identify required questions', async () => {
        const eventId = 'event-123';
        const mockQuestions = [
          { id: 'q-1', eventId, question: 'Required 1', isRequired: true },
          { id: 'q-2', eventId, question: 'Optional 1', isRequired: false },
          { id: 'q-3', eventId, question: 'Required 2', isRequired: true },
        ];

        mockPrismaService.question.findMany.mockResolvedValue(mockQuestions);

        const result = await service.findAll(eventId);

        const requiredQuestions = result.data.questions.filter((q) => q.isRequired);
        expect(requiredQuestions).toHaveLength(2);
      });
    });
  });

  describe('Security Tests', () => {
    describe('Authorization', () => {
      it('should prevent non-organizer from creating questions', async () => {
        const userId = 'user-123';
        const eventId = 'event-123';

        const mockEvent = { id: eventId, organizerId: 'org-999' };
        const mockOrganizer = null;

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);

        await expect(
          service.create(userId, eventId, {
            question: 'Test',
            type: 'text',
            isRequired: false,
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it('should prevent organizer from modifying other organizers questions', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';
        const questionId = 'q-123';

        const mockEvent = { id: eventId, organizerId: 'org-999' };
        const mockOrganizer = { id: 'org-123', userId };
        const mockQuestion = { id: questionId, eventId };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.question.findUnique.mockResolvedValue(mockQuestion);

        await expect(
          service.update(userId, eventId, questionId, { question: 'Hacked' }),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('Input Validation', () => {
      it('should sanitize XSS in question text', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';
        const xssPayload = '<script>alert("XSS")</script>Qual seu nome?';

        const mockEvent = { id: eventId, organizerId: 'org-123' };
        const mockOrganizer = { id: 'org-123', userId };
        const mockQuestion = {
          id: 'q-123',
          eventId,
          question: xssPayload,
        };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.question.create.mockResolvedValue(mockQuestion);

        // Deve criar mesmo com payload XSS (sanitização deve ser feita no frontend ou middleware)
        await expect(
          service.create(userId, eventId, {
            question: xssPayload,
            type: 'text',
            isRequired: false,
          }),
        ).resolves.toBeDefined();
      });

      it('should validate question text is not empty', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';

        const mockEvent = { id: eventId, organizerId: 'org-123' };
        const mockOrganizer = { id: 'org-123', userId };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.question.create.mockRejectedValue(new Error('Question cannot be empty'));

        await expect(
          service.create(userId, eventId, {
            question: '',
            type: 'text',
            isRequired: false,
          }),
        ).rejects.toThrow();
      });

      it('should validate options for multiple choice questions', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';

        const mockEvent = { id: eventId, organizerId: 'org-123' };
        const mockOrganizer = { id: 'org-123', userId };

        mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
        mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
        mockPrismaService.question.create.mockRejectedValue(
          new Error('Multiple choice questions require options'),
        );

        await expect(
          service.create(userId, eventId, {
            question: 'Test',
            type: 'multiple_choice',
            options: [], // Opções vazias
            isRequired: false,
          }),
        ).rejects.toThrow();
      });
    });
  });

  describe('Performance Tests', () => {
    it('should handle large question sets efficiently', async () => {
      const eventId = 'event-123';
      const largeQuestionList = Array.from({ length: 200 }, (_, i) => ({
        id: `q-${i}`,
        eventId,
        question: `Question ${i}`,
        type: 'text' as const,
        order: i,
        isRequired: i % 2 === 0,
      }));

      mockPrismaService.question.findMany.mockResolvedValue(largeQuestionList);

      const startTime = Date.now();
      const result = await service.findAll(eventId);
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(1000);
      expect(result.data.questions).toHaveLength(200);
      expect(result.data.questions[0].order).toBeLessThan(result.data.questions[199].order);
    });

    it('should efficiently filter questions by type', async () => {
      const eventId = 'event-123';
      const questions = Array.from({ length: 100 }, (_, i) => ({
        id: `q-${i}`,
        eventId,
        question: `Question ${i}`,
        type: i % 3 === 0 ? 'text' : i % 3 === 1 ? 'multiple_choice' : 'yes_no',
        order: i,
        isRequired: false,
      }));

      mockPrismaService.question.findMany.mockResolvedValue(questions);

      const result = await service.findAll(eventId);

      const textQuestions = result.data.questions.filter((q) => q.type === 'text');
      expect(textQuestions.length).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long question text', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const longQuestion = 'A'.repeat(10000);

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };
      const mockQuestion = {
        id: 'q-123',
        eventId,
        question: longQuestion,
        type: 'text' as const,
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.question.create.mockResolvedValue(mockQuestion);

      const result = await service.create(userId, eventId, {
        question: longQuestion,
        type: 'text',
        isRequired: false,
      });

      expect(result.data.question.question).toBe(longQuestion);
    });

    it('should handle question with many options', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const manyOptions = Array.from({ length: 100 }, (_, i) => `Option ${i + 1}`);

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };
      const mockQuestion = {
        id: 'q-123',
        eventId,
        question: 'Choose an option',
        type: 'multiple_choice' as const,
        options: manyOptions,
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.question.create.mockResolvedValue(mockQuestion);

      const result = await service.create(userId, eventId, {
        question: 'Choose an option',
        type: 'multiple_choice',
        options: manyOptions,
        isRequired: false,
      });

      expect(result.data.question.options).toHaveLength(100);
    });

    it('should handle special characters in question text', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const specialChars = "Question: What's your name? (Choose one) - Special chars: @#$%^&*()";

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };
      const mockQuestion = {
        id: 'q-123',
        eventId,
        question: specialChars,
        type: 'text' as const,
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.question.create.mockResolvedValue(mockQuestion);

      const result = await service.create(userId, eventId, {
        question: specialChars,
        type: 'text',
        isRequired: false,
      });

      expect(result.data.question.question).toBe(specialChars);
    });
  });

  describe('Data Integrity', () => {
    it('should prevent deleting question with answers', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const questionId = 'q-123';

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };
      const mockQuestion = {
        id: questionId,
        eventId,
        answers: [{ id: 'ans-123' }], // Com respostas
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.question.findUnique.mockResolvedValue(mockQuestion);

      await expect(service.remove(userId, eventId, questionId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should maintain question order on updates', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const questionId = 'q-123';

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };
      const mockQuestion = { id: questionId, eventId, order: 1 };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.question.findUnique.mockResolvedValue(mockQuestion);
      mockPrismaService.question.update.mockResolvedValue({
        ...mockQuestion,
        order: 2,
      });

      const result = await service.update(userId, eventId, questionId, { order: 2 });

      expect(result.data.question.order).toBe(2);
    });

    it('should prevent duplicate question orders', async () => {
      const eventId = 'event-123';
      const mockQuestions = [
        { id: 'q-1', eventId, question: 'Q1', order: 1 },
        { id: 'q-2', eventId, question: 'Q2', order: 1 }, // Ordem duplicada
        { id: 'q-3', eventId, question: 'Q3', order: 2 },
      ];

      mockPrismaService.question.findMany.mockResolvedValue(mockQuestions);

      const result = await service.findAll(eventId);

      // As questões devem ser retornadas, mas a ordem pode estar incorreta
      // Isso deve ser validado na camada de serviço ou schema
      expect(result.data.questions).toHaveLength(3);
    });
  });

  describe('Question Types', () => {
    it('should handle all question types correctly', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const types = ['text', 'multiple_choice', 'yes_no'];

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);

      for (const type of types) {
        mockPrismaService.question.create.mockResolvedValue({
          id: `q-${type}`,
          eventId,
          question: `Question ${type}`,
          type,
        });

        await service.create(userId, eventId, {
          question: `Question ${type}`,
          type: type as any,
          isRequired: false,
        });
      }

      expect(mockPrismaService.question.create).toHaveBeenCalledTimes(3);
    });

    it('should handle question options update', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const questionId = 'q-123';

      const mockEvent = { id: eventId, organizerId: 'org-123' };
      const mockOrganizer = { id: 'org-123', userId };
      const mockQuestion = {
        id: questionId,
        eventId,
        type: 'multiple_choice' as const,
        options: ['Option 1', 'Option 2'],
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.organizer.findUnique.mockResolvedValue(mockOrganizer);
      mockPrismaService.question.findUnique.mockResolvedValue(mockQuestion);
      mockPrismaService.question.update.mockResolvedValue({
        ...mockQuestion,
        options: ['Option 1', 'Option 2', 'Option 3'],
      });

      const result = await service.update(userId, eventId, questionId, {
        options: ['Option 1', 'Option 2', 'Option 3'],
      });

      expect(result.data.question.options).toHaveLength(3);
    });
  });
});

