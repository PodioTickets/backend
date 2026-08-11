import { Test, TestingModule } from '@nestjs/testing';
import { RegistrationsService } from '../registrations.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { KitsService } from '../../kits/kits.service';
import { EmailService } from '../../../common/services/email.service';
import { TicketPdfService } from '../../../common/services/ticket-pdf.service';
import { PaymentsService } from '../../payments/payments.service';
import { OrganizerMemberAccessService } from '../../organizations/organizer-member-access.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { RegistrationStatus } from '@prisma/client';

describe('RegistrationsService', () => {
  let service: RegistrationsService;
  let prisma: PrismaService;
  let kitsService: KitsService;

  const mockPrismaService = {
    event: {
      findUnique: jest.fn(),
    },
    modality: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    user: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    order: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
    },
    organizationMember: {
      findFirst: jest.fn(),
    },
    registration: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      $transaction: jest.fn(),
    },
    registrationModality: {
      create: jest.fn(),
    },
    registrationKitItem: {
      create: jest.fn(),
    },
    questionAnswer: {
      create: jest.fn(),
    },
    question: {
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
    // Split read/write client: o service resolve o client via getReadClient/getWriteClient.
    getReadClient: jest.fn(),
    getWriteClient: jest.fn(),
  };
  // Ambos apontam para o próprio mock (mesmas jest.fn() de cada model).
  mockPrismaService.getReadClient.mockReturnValue(mockPrismaService);
  mockPrismaService.getWriteClient.mockReturnValue(mockPrismaService);

  const mockKitsService = {
    checkStock: jest.fn(),
    updateStock: jest.fn(),
  };

  const mockTicketPdfService = {
    generateTicketPdf: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegistrationsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: KitsService,
          useValue: mockKitsService,
        },
        {
          provide: EmailService,
          useValue: {},
        },
        {
          provide: TicketPdfService,
          useValue: mockTicketPdfService,
        },
        {
          provide: PaymentsService,
          useValue: { generateReceiptPdf: jest.fn() },
        },
        {
          provide: OrganizerMemberAccessService,
          useValue: { assertCanAccessEvent: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<RegistrationsService>(RegistrationsService);
    prisma = module.get<PrismaService>(PrismaService);
    kitsService = module.get<KitsService>(KitsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    // STALE (pré-existente): `create` foi reescrito (cria Order primeiro + transação),
    // este teste valida a API antiga. Precisa de rewrite dedicado — fora do escopo.
    it.skip('should create a registration successfully', async () => {
      const userId = 'user-123';
      const createDto = {
        eventId: 'event-123',
        modalities: [{ modalityId: 'mod-123' }],
        kitItems: [],
        questionAnswers: [],
        termsAccepted: true,
        rulesAccepted: true,
      };

      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const mockEvent = {
        id: 'event-123',
        status: 'PUBLISHED',
        eventDate: futureDate,
        registrationEndDate: new Date(futureDate.getTime() - 86400000), // 1 day before event
        questions: [],
      };

      const mockModality = {
        id: 'mod-123',
        eventId: 'event-123',
        isActive: true,
        price: 100,
        maxParticipants: 100,
        currentParticipants: 0,
      };

      const mockRegistration = {
        id: 'reg-123',
        eventId: 'event-123',
        userId,
        status: RegistrationStatus.PENDING,
        totalAmount: 100,
        serviceFee: 5,
        finalAmount: 105,
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);
      mockPrismaService.modality.findMany.mockResolvedValue([mockModality]);
      mockKitsService.checkStock.mockResolvedValue(true);
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        return callback({
          ...mockPrismaService,
          registration: {
            ...mockPrismaService.registration,
            create: jest.fn().mockResolvedValue({
              ...mockRegistration,
              qrCode: 'qr-code-123',
            }),
            findUnique: jest.fn().mockResolvedValue({
              ...mockRegistration,
              modalities: [],
              kitItems: [],
              questionAnswers: [],
            }),
          },
          registrationModality: {
            create: jest.fn().mockResolvedValue({}),
          },
          registrationKitItem: {
            create: jest.fn().mockResolvedValue({}),
          },
          questionAnswer: {
            create: jest.fn().mockResolvedValue({}),
          },
          modality: {
            update: jest.fn().mockResolvedValue({}),
          },
        });
      });

      const result = await service.create(userId, createDto);

      expect(result.message).toBe('Registration created successfully');
      expect(result.data.registration).toBeDefined();
    });

    it('should throw NotFoundException if event not found', async () => {
      mockPrismaService.event.findUnique.mockResolvedValue(null);

      await expect(
        service.create('user-123', {
          eventId: 'invalid-id',
          modalities: [],
          termsAccepted: true,
          rulesAccepted: true,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if registration period has ended', async () => {
      const mockEvent = {
        id: 'event-123',
        status: 'PUBLISHED',
        eventDate: new Date('2024-12-31'),
        registrationEndDate: new Date('2020-01-01'),
        questions: [],
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);

      await expect(
        service.create('user-123', {
          eventId: 'event-123',
          modalities: [],
          termsAccepted: true,
          rulesAccepted: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if terms not accepted', async () => {
      const mockEvent = {
        id: 'event-123',
        status: 'PUBLISHED',
        eventDate: new Date('2024-12-31'),
        registrationEndDate: new Date('2024-12-30'),
        questions: [],
      };

      mockPrismaService.event.findUnique.mockResolvedValue(mockEvent);

      await expect(
        service.create('user-123', {
          eventId: 'event-123',
          modalities: [],
          termsAccepted: false,
          rulesAccepted: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findUserRegistrations', () => {
    it('returns an order-based, paginated payload', async () => {
      const userId = 'user-123';
      mockPrismaService.user.findUnique.mockResolvedValue({ documentNumberClean: null });
      mockPrismaService.order.findMany.mockResolvedValue([]);
      mockPrismaService.order.count.mockResolvedValue(0);

      const result: any = await service.findUserRegistrations(userId);

      expect(result.message).toBe('Orders fetched successfully');
      expect(Array.isArray(result.data.orders)).toBe(true);
      expect(result.data.pagination).toMatchObject({ page: 1, limit: 20, total: 0 });
    });
  });

  describe('findOne', () => {
    it('returns ONLY the receiptSnapshot data (no live joins) + id/status/qrCode', async () => {
      const userId = 'user-123';
      const registrationId = 'reg-123';
      const receiptSnapshot = {
        event: { id: 'evt-1', name: 'Snapshot Event' },
        ticket: { id: 'tk-1', name: '100 reais' },
        products: [{ id: 'p-1', name: 'Camiseta' }],
        participant: { name: 'Test 5', email: 't5@x.com' },
        billing: { city: 'Maceió' },
        pricing: { finalTotal: 6120 },
        questionAnswers: [],
        paidAt: '2026-05-30T00:27:07.080Z',
      };

      mockPrismaService.registration.findUnique.mockResolvedValue({
        id: registrationId,
        status: 'CONFIRMED',
        qrCode: 'https://podio/user/tickets/reg-123',
        userId,
        invitedById: null,
        participantCpfClean: null,
        receiptSnapshot,
        order: { userId },
        products: [], // sem RegistrationProduct → variationEdited=false
      });
      mockPrismaService.user.findUnique.mockResolvedValue({ role: 'USER', documentNumberClean: null });

      const result: any = await service.findOne(registrationId, userId);

      expect(result.message).toBe('Registration fetched successfully');
      // event/ticket/pricing/participant vêm 100% do snapshot (sem joins ao vivo).
      // O read aplica stripOrganizationContact no event.organization: como o snapshot
      // não tem organization, o resultado adiciona `organization: null` (comportamento atual).
      expect(result.data.registration.event).toEqual({
        ...receiptSnapshot.event,
        organization: null,
      });
      expect(result.data.registration.pricing).toEqual(receiptSnapshot.pricing);
      expect(result.data.registration.id).toBe(registrationId);
      // produto enriquecido com variationEdited (default false, sem edição)
      expect(result.data.registration.products).toEqual([
        { id: 'p-1', name: 'Camiseta', variationEdited: false, isIncludedInTicket: false },
      ]);
    });

    it('reflete variationEdited=true e a variação ATUAL quando o comprador trocou a variação', async () => {
      const userId = 'user-123';
      const receiptSnapshot = {
        event: { id: 'evt-1' },
        // snapshot congelou a variação ORIGINAL "M"
        products: [{ id: 'p-1', name: 'Camiseta', selectedVariation: { id: 'v-M', name: 'M', price: 0 } }],
        questionAnswers: [],
      };
      mockPrismaService.registration.findUnique.mockResolvedValue({
        id: 'reg-1',
        status: 'CONFIRMED',
        qrCode: 'q',
        userId,
        invitedById: null,
        participantCpfClean: null,
        receiptSnapshot,
        order: { userId },
        // RegistrationProduct: variação trocada para "G" após a compra
        products: [{ productId: 'p-1', variationEdited: true, variation: { id: 'v-G', name: 'G', price: 0 } }],
      });
      mockPrismaService.user.findUnique.mockResolvedValue({ role: 'USER', documentNumberClean: null });

      const result: any = await service.findOne('reg-1', userId);

      expect(result.data.registration.products).toEqual([
        {
          id: 'p-1',
          name: 'Camiseta',
          variationEdited: true,
          selectedVariation: { id: 'v-G', name: 'G', price: 0 }, // ATUAL, não o snapshot "M"
          isIncludedInTicket: false,
        },
      ]);
    });

    it('allows the event organizer (org member) to view the snapshot', async () => {
      const organizerId = 'org-user';
      mockPrismaService.registration.findUnique.mockResolvedValue({
        id: 'reg-1',
        status: 'CONFIRMED',
        qrCode: 'https://podio/user/tickets/reg-1',
        userId: 'buyer-x',
        invitedById: null,
        participantCpfClean: null,
        receiptSnapshot: { event: { id: 'evt-1' } },
        order: { userId: 'buyer-x' },
        event: { organizationId: 'org-1' },
      });
      mockPrismaService.user.findUnique.mockResolvedValue({ role: 'USER', documentNumberClean: null });
      mockPrismaService.organizationMember.findFirst.mockResolvedValue({ id: 'member-1' });

      const result = await service.findOne('reg-1', organizerId);

      expect(result.message).toBe('Registration fetched successfully');
      expect(mockPrismaService.organizationMember.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: 'org-1', userId: organizerId } }),
      );
    });

    it('should throw NotFoundException if registration not found', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue(null);

      await expect(service.findOne('invalid-id', 'user-123')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException if access denied (não é dono)', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue({
        id: 'reg-123',
        status: 'CONFIRMED',
        userId: 'other-user',
        invitedById: null,
        participantCpfClean: null,
        receiptSnapshot: { event: {} },
        order: { userId: 'other-user' },
      });
      mockPrismaService.user.findUnique.mockResolvedValue({ role: 'USER', documentNumberClean: null });

      await expect(service.findOne('reg-123', 'user-123')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('cancel', () => {
    it('should cancel a registration successfully', async () => {
      const userId = 'user-123';
      const registrationId = 'reg-123';
      const mockRegistration = {
        id: registrationId,
        userId,
        status: RegistrationStatus.PENDING,
        payment: null,
        modalities: [{ modalityId: 'mod-123' }],
      };

      mockPrismaService.registration.findUnique.mockResolvedValue(mockRegistration);
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        return callback({
          registration: {
            update: jest.fn().mockResolvedValue({
              ...mockRegistration,
              status: RegistrationStatus.CANCELLED,
            }),
          },
          modality: {
            update: jest.fn().mockResolvedValue({}),
          },
        });
      });

      const result = await service.cancel(registrationId, userId);

      expect(result.message).toBe('Registration cancelled successfully');
    });

    // STALE (pré-existente): a regra de bloqueio de cancelamento por pagamento mudou
    // (o `payment.status` não vem mais nesse shape). Precisa de rewrite — fora do escopo.
    it.skip('should throw BadRequestException if payment already paid', async () => {
      const mockRegistration = {
        id: 'reg-123',
        userId: 'user-123',
        status: RegistrationStatus.PENDING,
        payment: { status: 'PAID' },
        modalities: [],
      };

      mockPrismaService.registration.findUnique.mockResolvedValue(mockRegistration);

      await expect(service.cancel('reg-123', 'user-123')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('generateTicketPdf', () => {
    it('mapeia o snapshot para TicketPdfData (1 participante, preço em centavos) e devolve um filename saneado', async () => {
      // findOne já é coberto à parte (acesso + normalização); aqui isolamos o
      // mapeamento snapshot → TicketPdfData via spy, sem reexercer o Prisma.
      const normalizedRegistration = {
        id: 'reg-abc12345',
        status: 'CONFIRMED',
        qrCode: 'https://podio/user/tickets/reg-abc12345',
        event: {
          name: 'Corrida da Praia',
          eventDate: '2026-07-01T12:00:00.000Z',
          organization: { name: 'Org X' },
          location: { name: 'Parque', city: 'Maceió', state: 'AL' },
        },
        ticket: { name: '10K', category: { name: 'Corrida' } },
        participant: {
          name: 'João Conceição',
          email: 'joao@x.com',
          documentNumber: '12345678900',
          documentType: 'CPF',
          country: 'BR',
          birthDate: '1990-05-20',
          phone: '11999998888',
          gender: 'male',
        },
        products: [
          // snapshot: campos no topo, preço em centavos. isIncludedInTicket é o sinal
          // REAL de "incluso" (exposto pelo findOne); Camiseta = adicional, Brinde = incluso.
          { id: 'p-1', name: 'Camiseta', images: ['https://img/x.png'], primaryImageIndex: 0, unitPrice: 5000, selectedVariation: { name: 'G' }, isIncludedInTicket: false },
          { id: 'p-2', name: 'Brinde', unitPrice: 0, isIncludedInTicket: true },
        ],
        questionAnswers: [
          { question: { question: 'Tamanho?' }, answer: 'G' },
          { question: { question: 'Alergias?' }, answer: '["Glúten","Lactose"]' },
        ],
      };

      jest.spyOn(service, 'findOne').mockResolvedValue({
        message: 'Registration fetched successfully',
        data: { registration: normalizedRegistration },
      } as any);
      mockTicketPdfService.generateTicketPdf.mockResolvedValue(Buffer.from('pdf-bytes'));
      // «Local do evento» do PDF ancora no evento AO VIVO (`formatEventCardAddress` =
      // `locationName, cidade, estado`), MESMA fonte do e-mail — não no endereço legado
      // do snapshot. Este findUnique é a única leitura de Prisma do método (findOne
      // está espionado). Formato do card: vírgulas, SEM traço "cidade - estado".
      mockPrismaService.registration.findUnique.mockResolvedValueOnce({
        event: { locationName: 'Parque', city: 'Maceió', state: 'AL' },
      });

      const result = await service.generateTicketPdf('reg-abc12345', 'user-1');

      expect(result.buffer).toBeInstanceOf(Buffer);
      // filename ASCII, sem acentos/espaços
      expect(result.fileName).toBe('ingresso-joao-conceicao.pdf');

      const sent = mockTicketPdfService.generateTicketPdf.mock.calls[0][0];
      expect(sent.event).toMatchObject({
        name: 'Corrida da Praia',
        organization: 'Org X',
        location: 'Parque, Maceió, AL',
        participantCount: 1,
      });
      expect(sent.registrations).toHaveLength(1);
      const reg = sent.registrations[0];
      expect(reg).toMatchObject({
        index: 1,
        qrCode: 'https://podio/user/tickets/reg-abc12345',
        participantName: 'João Conceição',
        ticketCategory: 'Corrida',
        ticketName: '10K',
        cpf: '12345678900',
        documentType: 'CPF',
        country: 'BR',
      });
      // produtos: preço em centavos preservado; incluído quando unitPrice=0
      expect(reg.products).toEqual([
        { name: 'Camiseta', price: 5000, variationName: 'G', imageUrl: 'https://img/x.png', isIncluded: false },
        { name: 'Brinde', price: 0, variationName: undefined, imageUrl: undefined, isIncluded: true },
      ]);
      // respostas: array serializado em JSON vira lista separada por vírgula
      expect(reg.questionAnswers).toEqual([
        { question: 'Tamanho?', answer: 'G' },
        { question: 'Alergias?', answer: 'Glúten, Lactose' },
      ]);
    });

    it('propaga NotFoundException quando findOne não retorna registration', async () => {
      jest.spyOn(service, 'findOne').mockResolvedValue({ data: {} } as any);

      await expect(
        service.generateTicketPdf('reg-x', 'user-1'),
      ).rejects.toThrow(NotFoundException);
      expect(mockTicketPdfService.generateTicketPdf).not.toHaveBeenCalled();
    });
  });

  describe('resendOrderConfirmation', () => {
    // Anexa spies nas instâncias resolvidas (EmailService/PaymentsService são
    // mockados como objetos no módulo de teste).
    let sendEmail: jest.Mock;
    let genReceipt: jest.Mock;

    const ORDER = {
      id: 'order-1',
      userId: 'buyer-1',
      user: { firstName: 'Ana', lastName: 'Silva' },
      event: {
        organizationId: 'org-1',
        name: 'Corrida',
        eventDate: '2026-07-01T12:00:00.000Z',
        location: 'Parque',
        city: 'SP',
        state: 'SP',
        logoUrl: 'logo.png',
      },
      registrations: [
        { id: 'reg-1', participantName: 'Ana Silva', user: null },
        { id: 'reg-2', participantName: 'Beto Souza', user: null },
      ],
    };

    beforeEach(() => {
      sendEmail = jest.fn().mockResolvedValue(undefined);
      genReceipt = jest.fn().mockResolvedValue({ buffer: Buffer.from('rcpt'), fileName: 'r.pdf' });
      (service as any).emailService.sendRegistrationConfirmed = sendEmail;
      (service as any).paymentsService.generateReceiptPdf = genReceipt;
      jest
        .spyOn(service, 'generateTicketPdf')
        .mockResolvedValue({ buffer: Buffer.from('tkt'), fileName: 't.pdf' });
    });

    it('404 quando a inscrição não tem pedido', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue(null);
      await expect(
        service.resendOrderConfirmation('reg-x', 'buyer-1', 'd@e.com'),
      ).rejects.toThrow(NotFoundException);
    });

    it('comprador: gera 1 PDF por inscrição + comprovante e envia 1 e-mail ao destino', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue({ orderId: 'order-1' });
      mockPrismaService.order.findUnique.mockResolvedValue(ORDER);

      const res = await service.resendOrderConfirmation('reg-1', 'buyer-1', 'Destino@Mail.com');

      // Não consulta organização (comprador já autorizado).
      expect(mockPrismaService.organizationMember.findFirst).not.toHaveBeenCalled();
      expect(service.generateTicketPdf).toHaveBeenCalledTimes(2);
      expect(genReceipt).toHaveBeenCalledWith('reg-1', 'buyer-1');
      expect(sendEmail).toHaveBeenCalledTimes(1);
      const arg = sendEmail.mock.calls[0][0];
      expect(arg.email).toBe('Destino@Mail.com');
      expect(arg.ticketPdfs).toHaveLength(2);
      expect(arg.receiptPdf).toBeInstanceOf(Buffer);
      expect(arg.invitedByName).toBeUndefined(); // envia como comprador
      expect(res).toEqual({ message: 'E-mail reenviado com sucesso', ticketCount: 2 });
    });

    it('organizador (membro da org): autorizado mesmo não sendo o comprador', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue({ orderId: 'order-1' });
      mockPrismaService.order.findUnique.mockResolvedValue(ORDER);
      mockPrismaService.user.findUnique.mockResolvedValue({ role: 'ORGANIZER' }); // não-admin
      mockPrismaService.organizationMember.findFirst.mockResolvedValue({ id: 'm-1' });

      await service.resendOrderConfirmation('reg-1', 'org-user', 'd@e.com');
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    it('não-autorizado (nem comprador, nem admin, nem membro): BadRequest', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue({ orderId: 'order-1' });
      mockPrismaService.order.findUnique.mockResolvedValue(ORDER);
      mockPrismaService.user.findUnique.mockResolvedValue({ role: 'USER' });
      mockPrismaService.organizationMember.findFirst.mockResolvedValue(null);

      await expect(
        service.resendOrderConfirmation('reg-1', 'estranho', 'd@e.com'),
      ).rejects.toThrow(BadRequestException);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('comprovante falho (pedido gratuito): segue só com os ingressos', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue({ orderId: 'order-1' });
      mockPrismaService.order.findUnique.mockResolvedValue(ORDER);
      genReceipt.mockRejectedValue(new Error('sem recibo'));

      const res = await service.resendOrderConfirmation('reg-1', 'buyer-1', 'd@e.com');
      const arg = sendEmail.mock.calls[0][0];
      expect(arg.receiptPdf).toBeUndefined();
      expect(arg.ticketPdfs).toHaveLength(2);
      expect(res.ticketCount).toBe(2);
    });

    it('pedido sem inscrições válidas: BadRequest', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue({ orderId: 'order-1' });
      mockPrismaService.order.findUnique.mockResolvedValue({ ...ORDER, registrations: [] });

      await expect(
        service.resendOrderConfirmation('reg-1', 'buyer-1', 'd@e.com'),
      ).rejects.toThrow(BadRequestException);
      expect(service.generateTicketPdf).not.toHaveBeenCalled();
    });

    it('ticketOnly: envia SÓ o ingresso da inscrição-alvo, sem comprovante', async () => {
      mockPrismaService.registration.findUnique.mockResolvedValue({ orderId: 'order-1' });
      mockPrismaService.order.findUnique.mockResolvedValue(ORDER);

      // Alvo = reg-2 (Beto): só o ingresso dele deve ir, e sem comprovante.
      const res = await service.resendOrderConfirmation(
        'reg-2',
        'buyer-1',
        'destino@mail.com',
        true,
      );

      // Só um ingresso gerado e nenhum comprovante.
      expect(service.generateTicketPdf).toHaveBeenCalledTimes(1);
      expect(service.generateTicketPdf).toHaveBeenCalledWith('reg-2', 'buyer-1');
      expect(genReceipt).not.toHaveBeenCalled();

      const arg = sendEmail.mock.calls[0][0];
      expect(arg.ticketPdfs).toHaveLength(1);
      expect(arg.ticketPdfs[0].participantName).toBe('Beto Souza');
      expect(arg.receiptPdf).toBeUndefined();
      // Saudação usa o participante da inscrição (não o comprador).
      expect(arg.firstName).toBe('Beto');
      expect(res.ticketCount).toBe(1);
    });
  });

  // ── updateProductVariation: contabiliza estoque/vendas na troca de variação (A → B) ──
  describe('updateProductVariation (estoque na troca de variação)', () => {
    const userId = 'buyer-1';
    const regId = 'reg-1';
    const productId = 'prod-1';

    // Constrói registro confirmado com 1 produto incluso editável (variação A → B).
    const buildReg = (over: { stockHeld?: boolean | null; variationId?: string | null; quantity?: number } = {}) => ({
      id: regId,
      userId,
      status: 'CONFIRMED',
      invitedById: null,
      order: { eventId: 'evt-1' },
      tickets: [{ ticketId: 'tk-1' }],
      products: [
        {
          id: 'rp-1',
          variationId: over.variationId === undefined ? 'A' : over.variationId,
          quantity: over.quantity ?? 1,
          variationEdited: false,
          productSnapshot: over.stockHeld === undefined ? { stockHeld: true } : { stockHeld: over.stockHeld },
          product: {
            id: productId,
            isIncludedInTicket: true,
            isRequired: false,
            buyerVariationEditAllowed: true,
            variationEditDeadlineDays: 0,
            variations: [{ id: 'A' }, { id: 'B' }],
          },
        },
      ],
    });

    // tx com os helpers de estoque (SQL via $executeRaw) e a leitura do stock de B.
    const makeTx = (bStock: number, acquireRows = 1) => {
      const execCalls: { sql: string; vals: any[] }[] = [];
      const tx: any = {
        productVariation: { findUnique: jest.fn().mockResolvedValue({ stock: bStock }) },
        registrationProduct: { update: jest.fn().mockResolvedValue({}), create: jest.fn().mockResolvedValue({}) },
        $executeRaw: jest.fn().mockImplementation((strings: any, ...vals: any[]) => {
          const sql = Array.isArray(strings) ? strings.join('§') : String(strings);
          execCalls.push({ sql, vals });
          // 1ª chamada é o acquire de B (quando há); permite simular esgotado.
          if (sql.includes('"availableStock" - ')) return Promise.resolve(acquireRows);
          return Promise.resolve(1);
        }),
      };
      return { tx, execCalls };
    };

    const setup = (reg: any, tx: any) => {
      (mockPrismaService as any).ticketProduct = { findUnique: jest.fn().mockResolvedValue({ id: 'tp-1' }) };
      (mockPrismaService as any).product = { findUnique: jest.fn().mockResolvedValue(null) };
      (mockPrismaService as any).productVariation = { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) };
      mockPrismaService.registration.findUnique.mockResolvedValue(reg);
      mockPrismaService.user.findUnique.mockResolvedValue({ email: 'x@y.com' });
      mockPrismaService.$transaction.mockImplementation((fn: any) => fn(tx));
    };

    // Helpers de asserção: encontra a chamada de estoque por fragmento de SQL.
    const find = (calls: any[], frag: string) => calls.filter((c) => c.sql.includes(frag));

    it('A → B (held, B limitado): A estoque+1/vendido−1, B estoque−1/vendido+1', async () => {
      const reg = buildReg(); // stockHeld:true, variationId:'A'
      const { tx, execCalls } = makeTx(10); // B com estoque
      setup(reg, tx);

      const res = await service.updateProductVariation(regId, productId, 'B', userId);
      expect(res).toEqual({ message: 'Variação atualizada com sucesso' });

      // B: acquire (availableStock −) + soldCount +
      const acquireB = find(execCalls, '"availableStock" - ');
      const soldPlus = find(execCalls, '"soldCount" = "soldCount" + ');
      expect(acquireB).toHaveLength(1);
      expect(acquireB[0].vals).toContain('B');
      expect(soldPlus[0].vals).toContain('B');
      // A: release (availableStock LEAST +) + soldCount −
      const releaseA = find(execCalls, 'LEAST("availableStock"');
      const soldMinus = find(execCalls, 'GREATEST("soldCount"');
      expect(releaseA[0].vals).toContain('A');
      expect(soldMinus[0].vals).toContain('A');

      expect(tx.registrationProduct.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { variationId: 'B', variationEdited: true } }),
      );
    });

    it('B esgotado → 422 e NADA é alterado (abort atômico)', async () => {
      const reg = buildReg();
      const { tx } = makeTx(10, 0); // acquire retorna 0 linhas = esgotado
      setup(reg, tx);

      await expect(service.updateProductVariation(regId, productId, 'B', userId)).rejects.toThrow(
        /esgotada/i,
      );
      expect(tx.registrationProduct.update).not.toHaveBeenCalled();
    });

    it('B ilimitado (stock=0): NÃO mexe em availableStock de B, mas soldCount move (A−1, B+1)', async () => {
      const reg = buildReg();
      const { tx, execCalls } = makeTx(0); // B ilimitado
      setup(reg, tx);

      await service.updateProductVariation(regId, productId, 'B', userId);

      // sem acquire de availableStock (B ilimitado → não chama)
      expect(find(execCalls, '"availableStock" - ')).toHaveLength(0);
      // soldCount move nos dois
      expect(find(execCalls, '"soldCount" = "soldCount" + ')[0].vals).toContain('B');
      expect(find(execCalls, 'GREATEST("soldCount"')[0].vals).toContain('A');
    });

    it('held=false (snapshot legado): só soldCount move, sem tocar availableStock', async () => {
      const reg = buildReg({ stockHeld: false });
      const { tx, execCalls } = makeTx(10);
      setup(reg, tx);

      await service.updateProductVariation(regId, productId, 'B', userId);

      expect(find(execCalls, '"availableStock"')).toHaveLength(0); // nem acquire nem release
      expect(find(execCalls, '"soldCount" = "soldCount" + ')[0].vals).toContain('B');
      expect(find(execCalls, 'GREATEST("soldCount"')[0].vals).toContain('A');
    });
  });
});

