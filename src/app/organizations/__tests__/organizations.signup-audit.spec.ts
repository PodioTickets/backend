/**
 * ROTEIRO — rastro de compliance no auto-cadastro de organizador
 * ==============================================================
 * `signupOrganizer` deve, além de criar user/org/member:
 *   1. Gravar UM `ContractAcceptance` por contrato (4) com versão autoritativa do
 *      servidor + IP + user-agent do request (prova do aceite; Contrato Principal 4.4).
 *   2. Registrar a criação na auditoria (`recordOrganizationAuditLog`,
 *      action 'Organização criada (auto-cadastro)', ator = owner recém-criado).
 */
import { OrganizationsService } from '../organizations.service';
import { ORGANIZER_CONTRACTS } from '../organizer-contracts.constant';
import { SignupPersonType } from '../dto/organizer-signup.dto';

describe('OrganizationsService.signupOrganizer — rastro de aceite e auditoria', () => {
  const build = () => {
    const createMany = jest.fn().mockResolvedValue({ count: ORGANIZER_CONTRACTS.length });
    const tx: any = {
      user: {
        create: jest.fn().mockResolvedValue({
          id: 'user-1', email: 'org@ex.com', firstName: 'Fulano', lastName: 'Silva',
        }),
      },
      organization: {
        create: jest.fn().mockResolvedValue({
          id: 'org-1', name: 'Minha Org', tradeName: 'Minha Org', email: 'contato@ex.com',
        }),
      },
      organizationMember: {
        create: jest.fn().mockResolvedValue({ id: 'mem-1', user: {}, organization: {} }),
      },
      contractAcceptance: { createMany },
    };
    const readClient: any = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      organization: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const writeClient: any = { $transaction: (cb: any) => cb(tx) };
    const prisma: any = {
      getReadClient: () => readClient,
      getWriteClient: () => writeClient,
    };
    const emailService: any = {
      sendWelcomeOrganizer: jest.fn().mockResolvedValue(undefined),
      sendMemberAdded: jest.fn().mockResolvedValue(undefined),
    };
    const service = new OrganizationsService(prisma, {} as any, emailService, { record: jest.fn(), recordForEvent: jest.fn() } as any);
    // Unicidades de negócio (docs/e-mails) fora do escopo deste teste.
    jest.spyOn(service as any, 'isOrganizationOwnerDocumentAvailable').mockResolvedValue(true);
    jest.spyOn(service as any, 'isOrganizationEmailAvailable').mockResolvedValue(true);
    const auditSpy = jest
      .spyOn(service, 'recordOrganizationAuditLog')
      .mockResolvedValue(undefined as any);
    return { service, createMany, auditSpy };
  };

  const pfDto = () =>
    ({
      personType: SignupPersonType.PF,
      completeName: 'Fulano Silva',
      email: 'org@ex.com',
      password: 'senhaForte123',
      ownerDocument: '390.533.447-05', // CPF válido
      ownerName: 'Fulano Silva',
      tradeName: 'Minha Org',
      orgEmail: 'contato@ex.com',
      phone: '65999990000',
      whatsapp: '65999990000',
      zipCode: '78005-560',
      street: 'Rua X',
      number: '10',
      neighborhood: 'Centro',
      city: 'Cuiabá',
      state: 'MT',
    }) as any;

  it('grava um ContractAcceptance por contrato, com versão/IP/user-agent', async () => {
    const { service, createMany } = build();

    await service.signupOrganizer(pfDto(), { ip: '203.0.113.9', userAgent: 'jest-UA' });

    expect(createMany).toHaveBeenCalledTimes(1);
    const rows = createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(ORGANIZER_CONTRACTS.length);
    // Cobre exatamente os 4 contratos canônicos.
    expect(new Set(rows.map((r: any) => r.contractId))).toEqual(
      new Set(ORGANIZER_CONTRACTS.map((c) => c.id)),
    );
    for (const r of rows) {
      const canon = ORGANIZER_CONTRACTS.find((c) => c.id === r.contractId);
      expect(r.version).toBe(canon!.version);
      expect(r.userId).toBe('user-1');
      expect(r.organizationId).toBe('org-1');
      expect(r.ip).toBe('203.0.113.9');
      expect(r.userAgent).toBe('jest-UA');
    }
  });

  it('registra a criação na auditoria (ator = owner; ação de auto-cadastro)', async () => {
    const { service, auditSpy } = build();

    await service.signupOrganizer(pfDto(), { ip: '203.0.113.9', userAgent: 'jest-UA' });

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const arg = auditSpy.mock.calls[0][0];
    expect(arg.organizationId).toBe('org-1');
    expect(arg.actorUserId).toBe('user-1');
    expect(arg.ip).toBe('203.0.113.9');
    expect(arg.action).toBe('Organização criada (auto-cadastro)');
  });

  it('sem context → aceite gravado com ip/userAgent nulos (não quebra)', async () => {
    const { service, createMany } = build();

    await service.signupOrganizer(pfDto());

    const rows = createMany.mock.calls[0][0].data;
    expect(rows[0].ip).toBeNull();
    expect(rows[0].userAgent).toBeNull();
  });
});
