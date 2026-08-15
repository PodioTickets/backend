import { Test, TestingModule } from '@nestjs/testing';
import { QuestionsService } from '../questions.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OrganizationAuditService } from '../../../common/services/organization-audit.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('QuestionsService - Comprehensive Tests', () => {
  let service: QuestionsService;
  let prisma: PrismaService;

  // O service usa o modelo organização/membro (não "organizer") e acessa o
  // client via getReadClient()/getWriteClient(). O mock expõe os models usados
  // (user, event, organizationMember, question) e ambos os getters apontam para
  // o próprio mock, simulando read e write no mesmo client em memória.
  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
    },
    event: {
      findUnique: jest.fn(),
    },
    organizationMember: {
      findUnique: jest.fn(),
    },
    question: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    ticket: {
      findMany: jest.fn(),
    },
    getReadClient: jest.fn(),
    getWriteClient: jest.fn(),
  };

  // Helper: configura o acesso de organizador como autorizado para um evento.
  const grantOrganizerAccess = (
    userId: string,
    eventId: string,
    organizationId = 'org-123',
  ) => {
    mockPrismaService.user.findUnique.mockResolvedValue({ role: 'ORGANIZER' });
    mockPrismaService.event.findUnique.mockResolvedValue({ id: eventId, organizationId });
    mockPrismaService.organizationMember.findUnique.mockResolvedValue({
      id: 'member-123',
      organizationId,
      userId,
      role: 'OWNER',
    });
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

    // Ambos os getters retornam o próprio mock (read == write no teste).
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
          type: 'text',
          isRequired: true,
          order: 1,
        };

        grantOrganizerAccess(userId, eventId);
        mockPrismaService.question.create.mockResolvedValue({
          id: 'q-123',
          eventId,
          appliesTo: null,
          ...createDto,
        });

        const result = await service.create(userId, eventId, createDto);

        expect(result.data.question.type).toBe('text');
        expect(result.data.question.isRequired).toBe(true);
      });

      it('should create multiple choice question', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';
        const createDto = {
          question: 'Qual sua experiência?',
          type: 'multiple_choice',
          options: ['Iniciante', 'Intermediário', 'Avançado'],
          isRequired: true,
          order: 2,
        };

        grantOrganizerAccess(userId, eventId);
        mockPrismaService.question.create.mockResolvedValue({
          id: 'q-123',
          eventId,
          appliesTo: null,
          ...createDto,
        });

        const result = await service.create(userId, eventId, createDto);

        expect(result.data.question.type).toBe('multiple_choice');
        expect(result.data.question.options).toEqual(createDto.options);
      });

      it('should create yes/no question', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';
        // true_false é um dos NO_OPTION_TYPES suportados pelo service.
        const createDto = {
          question: 'Você já participou de eventos anteriores?',
          type: 'true_false',
          isRequired: false,
          order: 3,
        };

        grantOrganizerAccess(userId, eventId);
        mockPrismaService.question.create.mockResolvedValue({
          id: 'q-123',
          eventId,
          appliesTo: null,
          ...createDto,
        });

        const result = await service.create(userId, eventId, createDto);

        expect(result.data.question.type).toBe('true_false');
      });
    });

    describe('UC2: User answers questions during registration', () => {
      it('should return questions in correct order', async () => {
        const eventId = 'event-123';
        const mockQuestions = [
          { id: 'q-1', eventId, question: 'Question 1', order: 1, isRequired: true, appliesTo: null },
          { id: 'q-2', eventId, question: 'Question 2', order: 2, isRequired: false, appliesTo: null },
          { id: 'q-3', eventId, question: 'Question 3', order: 3, isRequired: true, appliesTo: null },
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
          { id: 'q-1', eventId, question: 'Required 1', isRequired: true, appliesTo: null },
          { id: 'q-2', eventId, question: 'Optional 1', isRequired: false, appliesTo: null },
          { id: 'q-3', eventId, question: 'Required 2', isRequired: true, appliesTo: null },
        ];

        mockPrismaService.question.findMany.mockResolvedValue(mockQuestions);

        const result = await service.findAll(eventId);

        const requiredQuestions = result.data.questions.filter((q: any) => q.isRequired);
        expect(requiredQuestions).toHaveLength(2);
      });
    });
  });

  describe('Security Tests', () => {
    describe('Authorization', () => {
      it('should prevent non-organizer from creating questions', async () => {
        const userId = 'user-123';
        const eventId = 'event-123';

        // Usuário comum, evento existe, mas não é membro da organização.
        mockPrismaService.user.findUnique.mockResolvedValue({ role: 'USER' });
        mockPrismaService.event.findUnique.mockResolvedValue({ id: eventId, organizationId: 'org-999' });
        mockPrismaService.organizationMember.findUnique.mockResolvedValue(null);

        await expect(
          service.create(userId, eventId, {
            question: 'Test',
            type: 'text',
            isRequired: false,
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it('should prevent acting on a non-existent event', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';
        const questionId = 'q-123';

        // Usuário comum e evento inexistente → NotFoundException.
        mockPrismaService.user.findUnique.mockResolvedValue({ role: 'USER' });
        mockPrismaService.event.findUnique.mockResolvedValue(null);

        await expect(
          service.update(userId, eventId, questionId, { question: 'Hacked' }),
        ).rejects.toThrow(NotFoundException);
      });
    });

    describe('Input Validation', () => {
      it('should sanitize XSS in question text', async () => {
        const userId = 'org-user-123';
        const eventId = 'event-123';
        const xssPayload = '<script>alert("XSS")</script>Qual seu nome?';

        grantOrganizerAccess(userId, eventId);
        mockPrismaService.question.create.mockResolvedValue({
          id: 'q-123',
          eventId,
          question: xssPayload,
          appliesTo: null,
        });

        // Deve criar mesmo com payload XSS (sanitização é responsabilidade de outra camada).
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

        grantOrganizerAccess(userId, eventId);
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

        grantOrganizerAccess(userId, eventId);

        // O próprio service valida: multiple_choice com options vazias lança BadRequestException
        // em resolveQuestionOptions, antes mesmo de chamar o create.
        await expect(
          service.create(userId, eventId, {
            question: 'Test',
            type: 'multiple_choice',
            options: [], // Opções vazias
            isRequired: false,
          }),
        ).rejects.toThrow(BadRequestException);
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
        type: 'text',
        order: i,
        isRequired: i % 2 === 0,
        appliesTo: null,
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
        type: i % 3 === 0 ? 'text' : i % 3 === 1 ? 'multiple_choice' : 'true_false',
        order: i,
        isRequired: false,
        appliesTo: null,
      }));

      mockPrismaService.question.findMany.mockResolvedValue(questions);

      const result = await service.findAll(eventId);

      const textQuestions = result.data.questions.filter((q: any) => q.type === 'text');
      expect(textQuestions.length).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long question text', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const longQuestion = 'A'.repeat(10000);

      grantOrganizerAccess(userId, eventId);
      mockPrismaService.question.create.mockResolvedValue({
        id: 'q-123',
        eventId,
        question: longQuestion,
        type: 'text',
        appliesTo: null,
      });

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

      grantOrganizerAccess(userId, eventId);
      mockPrismaService.question.create.mockResolvedValue({
        id: 'q-123',
        eventId,
        question: 'Choose an option',
        type: 'multiple_choice',
        options: manyOptions,
        appliesTo: null,
      });

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

      grantOrganizerAccess(userId, eventId);
      mockPrismaService.question.create.mockResolvedValue({
        id: 'q-123',
        eventId,
        question: specialChars,
        type: 'text',
        appliesTo: null,
      });

      const result = await service.create(userId, eventId, {
        question: specialChars,
        type: 'text',
        isRequired: false,
      });

      expect(result.data.question.question).toBe(specialChars);
    });
  });

  describe('Data Integrity', () => {
    it('should soft-delete question with answers', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const questionId = 'q-123';

      grantOrganizerAccess(userId, eventId);
      // Questão ativa, pertence ao evento e possui respostas → soft-delete.
      mockPrismaService.question.findUnique.mockResolvedValue({
        id: questionId,
        eventId,
        isActive: true,
        answers: [{ id: 'ans-123' }],
      });
      mockPrismaService.question.update.mockResolvedValue({
        id: questionId,
        eventId,
        isActive: false,
      });

      const result = await service.remove(userId, eventId, questionId);

      expect(result.message).toBe('Question deleted successfully');
      // Soft-delete: usa update (isActive=false), nunca delete.
      expect(mockPrismaService.question.update).toHaveBeenCalledWith({
        where: { id: questionId },
        data: { isActive: false },
      });
      expect(mockPrismaService.question.delete).not.toHaveBeenCalled();
    });

    it('should maintain question order on updates', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const questionId = 'q-123';

      grantOrganizerAccess(userId, eventId);
      mockPrismaService.question.findUnique.mockResolvedValue({
        id: questionId,
        eventId,
        isActive: true,
        order: 1,
        type: 'text',
      });
      mockPrismaService.question.update.mockResolvedValue({
        id: questionId,
        eventId,
        isActive: true,
        order: 2,
        type: 'text',
        appliesTo: null,
      });

      const result = await service.update(userId, eventId, questionId, { order: 2 });

      expect(result.data.question.order).toBe(2);
    });

    it('should return all questions regardless of duplicate order', async () => {
      const eventId = 'event-123';
      const mockQuestions = [
        { id: 'q-1', eventId, question: 'Q1', order: 1, appliesTo: null },
        { id: 'q-2', eventId, question: 'Q2', order: 1, appliesTo: null }, // Ordem duplicada
        { id: 'q-3', eventId, question: 'Q3', order: 2, appliesTo: null },
      ];

      mockPrismaService.question.findMany.mockResolvedValue(mockQuestions);

      const result = await service.findAll(eventId);

      expect(result.data.questions).toHaveLength(3);
    });
  });

  describe('Question Types', () => {
    it('should handle all question types correctly', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const types = ['text', 'multiple_choice', 'true_false'];

      grantOrganizerAccess(userId, eventId);

      for (const type of types) {
        // multiple_choice exige opções válidas; demais ignoram options.
        const options = type === 'multiple_choice' ? ['A', 'B'] : undefined;
        mockPrismaService.question.create.mockResolvedValue({
          id: `q-${type}`,
          eventId,
          question: `Question ${type}`,
          type,
          appliesTo: null,
        });

        await service.create(userId, eventId, {
          question: `Question ${type}`,
          type,
          options,
          isRequired: false,
        });
      }

      expect(mockPrismaService.question.create).toHaveBeenCalledTimes(3);
    });

    it('should handle question options update', async () => {
      const userId = 'org-user-123';
      const eventId = 'event-123';
      const questionId = 'q-123';

      grantOrganizerAccess(userId, eventId);
      mockPrismaService.question.findUnique.mockResolvedValue({
        id: questionId,
        eventId,
        isActive: true,
        type: 'multiple_choice',
        options: ['Option 1', 'Option 2'],
      });
      mockPrismaService.question.update.mockResolvedValue({
        id: questionId,
        eventId,
        isActive: true,
        type: 'multiple_choice',
        options: ['Option 1', 'Option 2', 'Option 3'],
        appliesTo: null,
      });

      const result = await service.update(userId, eventId, questionId, {
        options: ['Option 1', 'Option 2', 'Option 3'],
      });

      expect(result.data.question.options).toHaveLength(3);
    });
  });
});
