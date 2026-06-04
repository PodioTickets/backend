/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: controle de ACESSO do painel do organizador.
 *           Decide QUEM (qual usuário) pode mexer em QUAL evento e fazer O QUÊ.
 *
 *  EM RESUMO:
 *    Uma organização tem "membros" (colaboradores). Cada membro tem um PAPEL:
 *      • DONO (OWNER): pode tudo, em todos os eventos da organização.
 *      • FUNCIONÁRIO (EMPLOYEE): pode só o que as PERMISSÕES dele liberam, e só
 *        nos eventos que ele tem acesso.
 *    Administradores do sistema (ADMIN / PODIOGO_STAFF) passam direto por qualquer
 *    checagem — eles enxergam tudo.
 *
 *  AS REGRAS QUE PRECISAM SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Administrador do sistema → liberado em qualquer evento, sem precisar de vínculo.
 *    • Evento que não existe → erro "não encontrado".
 *    • Usuário SEM vínculo com a organização do evento → acesso NEGADO.
 *    • DONO da organização → liberado em qualquer evento e qualquer permissão.
 *    • Funcionário SEM a permissão exigida → acesso NEGADO.
 *    • Funcionário COM a permissão exigida → liberado.
 *    • Funcionário "restrito a eventos" e sem eventos atribuídos → não vê NENHUM evento.
 *    • Funcionário com lista de eventos → só os eventos da lista (outro evento da
 *      mesma org → negado).
 *    • Usuário é membro da org A, mas tenta um evento da org B → acesso NEGADO.
 *    • O primeiro vínculo do usuário é recuperado (ou erro se ele não for organizador).
 *    • O filtro de eventos do painel respeita papel/restrição/lista.
 *    • A leitura de uma permissão pontual respeita papel e o JSON de permissões.
 *
 *  COMO CONFERIMOS:
 *    Teste DE VERDADE contra um banco de teste (descartável). Criamos organização,
 *    usuário, evento e o VÍNCULO membro↔organização REAIS no banco, chamamos o
 *    serviço e conferimos o que acontece. O banco é limpo antes de cada cenário.
 * ============================================================================
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrganizerMemberAccessService } from '../organizer-member-access.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  createTestPrisma,
  resetDb,
  seedOrganization,
  seedUser,
  seedEvent,
} from '../../../common/testing/integration-db';

describe('OrganizerMemberAccessService (integração, banco real)', () => {
  let prisma: PrismaService;
  let service: OrganizerMemberAccessService;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    service = new OrganizerMemberAccessService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma); // banco limpo antes de cada cenário
  });

  // ---------------------------------------------------------------------------
  // Helpers de seed do VÍNCULO membro ↔ organização (foco deste serviço)
  // ---------------------------------------------------------------------------

  /**
   * Cria o vínculo membro↔organização REAL.
   * Campos obrigatórios em OrganizationMember: organizationId, userId.
   * `role` default no schema é EMPLOYEE; `restrictedToEvents` default false;
   * `permissions` (Json?) é opcional — null = legado (tratado como acesso total).
   */
  const linkMember = (params: {
    organizationId: string;
    userId: string;
    role?: 'OWNER' | 'EMPLOYEE';
    permissions?: Record<string, boolean> | null;
    restrictedToEvents?: boolean;
  }) =>
    prisma.getWriteClient().organizationMember.create({
      data: {
        organizationId: params.organizationId,
        userId: params.userId,
        role: (params.role ?? 'EMPLOYEE') as any,
        permissions: params.permissions ?? undefined,
        restrictedToEvents: params.restrictedToEvents ?? false,
      },
      select: { id: true },
    });

  /** Atribui um evento específico ao membro (whitelist OrganizationMemberEventAccess). */
  const grantEvent = (organizationMemberId: string, eventId: string) =>
    prisma.getWriteClient().organizationMemberEventAccess.create({
      data: { organizationMemberId, eventId },
    });

  // ===========================================================================
  // assertCanAccessEvent — o coração da regra de acesso
  // ===========================================================================
  describe('assertCanAccessEvent', () => {
    it('libera administrador do sistema (ADMIN) sem precisar de vínculo nem do evento', async () => {
      const orgId = await seedOrganization(prisma);
      const eventId = await seedEvent(prisma, orgId);
      const adminId = await seedUser(prisma, 'ADMIN'); // sem vínculo com a org

      await expect(
        service.assertCanAccessEvent(adminId, eventId, 'financial'),
      ).resolves.toBeUndefined();
    });

    it('libera staff do sistema (PODIOGO_STAFF) sem vínculo', async () => {
      const orgId = await seedOrganization(prisma);
      const eventId = await seedEvent(prisma, orgId);
      const staffId = await seedUser(prisma, 'PODIOGO_STAFF');

      await expect(
        service.assertCanAccessEvent(staffId, eventId, 'edit_event'),
      ).resolves.toBeUndefined();
    });

    it('erro "não encontrado" quando o evento não existe', async () => {
      const userId = await seedUser(prisma, 'USER');
      // UUID válido porém inexistente
      const fakeEventId = '00000000-0000-0000-0000-000000000000';

      await expect(
        service.assertCanAccessEvent(userId, fakeEventId, 'view_event'),
      ).rejects.toThrow(NotFoundException);
    });

    it('NEGA usuário comum sem vínculo com a organização do evento', async () => {
      const orgId = await seedOrganization(prisma);
      const eventId = await seedEvent(prisma, orgId);
      const estranhoId = await seedUser(prisma, 'USER'); // não-admin, sem vínculo

      await expect(
        service.assertCanAccessEvent(estranhoId, eventId, 'view_event'),
      ).rejects.toThrow(BadRequestException);
    });

    it('libera o DONO (OWNER) em qualquer evento e qualquer permissão', async () => {
      const orgId = await seedOrganization(prisma);
      const eventId = await seedEvent(prisma, orgId);
      const ownerId = await seedUser(prisma, 'USER');
      await linkMember({ organizationId: orgId, userId: ownerId, role: 'OWNER' });

      // OWNER ignora permissões armazenadas → libera até as mais sensíveis
      await expect(
        service.assertCanAccessEvent(ownerId, eventId, 'financial'),
      ).resolves.toBeUndefined();
    });

    it('NEGA funcionário que não tem a permissão exigida', async () => {
      const orgId = await seedOrganization(prisma);
      const eventId = await seedEvent(prisma, orgId);
      const empId = await seedUser(prisma, 'USER');
      // só "view_event"; "financial" fica false
      await linkMember({
        organizationId: orgId,
        userId: empId,
        role: 'EMPLOYEE',
        permissions: { view_event: true },
      });

      await expect(
        service.assertCanAccessEvent(empId, eventId, 'financial'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('libera funcionário que TEM a permissão exigida', async () => {
      const orgId = await seedOrganization(prisma);
      const eventId = await seedEvent(prisma, orgId);
      const empId = await seedUser(prisma, 'USER');
      await linkMember({
        organizationId: orgId,
        userId: empId,
        role: 'EMPLOYEE',
        permissions: { view_event: true },
      });

      await expect(
        service.assertCanAccessEvent(empId, eventId, 'view_event'),
      ).resolves.toBeUndefined();
    });

    it('NEGA funcionário "restrito a eventos" e SEM eventos atribuídos (não vê nenhum)', async () => {
      const orgId = await seedOrganization(prisma);
      const eventId = await seedEvent(prisma, orgId);
      const empId = await seedUser(prisma, 'USER');
      await linkMember({
        organizationId: orgId,
        userId: empId,
        role: 'EMPLOYEE',
        permissions: { view_event: true },
        restrictedToEvents: true, // sem grantEvent → fora de escopo
      });

      await expect(
        service.assertCanAccessEvent(empId, eventId, 'view_event'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('libera funcionário restrito QUANDO o evento está na whitelist dele', async () => {
      const orgId = await seedOrganization(prisma);
      const eventId = await seedEvent(prisma, orgId);
      const empId = await seedUser(prisma, 'USER');
      const m = await linkMember({
        organizationId: orgId,
        userId: empId,
        role: 'EMPLOYEE',
        permissions: { view_event: true },
        restrictedToEvents: true,
      });
      await grantEvent(m.id, eventId); // evento liberado para o membro

      await expect(
        service.assertCanAccessEvent(empId, eventId, 'view_event'),
      ).resolves.toBeUndefined();
    });

    it('NEGA funcionário com whitelist quando o evento alvo NÃO está na lista (outro evento da MESMA org)', async () => {
      const orgId = await seedOrganization(prisma);
      const eventPermitido = await seedEvent(prisma, orgId);
      const eventProibido = await seedEvent(prisma, orgId); // mesma org, fora da lista
      const empId = await seedUser(prisma, 'USER');
      const m = await linkMember({
        organizationId: orgId,
        userId: empId,
        role: 'EMPLOYEE',
        permissions: { view_event: true },
      });
      await grantEvent(m.id, eventPermitido); // só este entra na whitelist

      await expect(
        service.assertCanAccessEvent(empId, eventProibido, 'view_event'),
      ).rejects.toThrow(ForbiddenException);
      // o permitido continua liberado
      await expect(
        service.assertCanAccessEvent(empId, eventPermitido, 'view_event'),
      ).resolves.toBeUndefined();
    });

    it('NEGA membro da org A tentando acessar um evento da org B (recurso de OUTRA organização)', async () => {
      const orgA = await seedOrganization(prisma);
      const orgB = await seedOrganization(prisma);
      const eventoDaB = await seedEvent(prisma, orgB);
      const userId = await seedUser(prisma, 'USER');
      // é DONO da A, mas nada na B
      await linkMember({ organizationId: orgA, userId, role: 'OWNER' });

      // evento existe (org B), porém o usuário não é membro da org B → BadRequest
      await expect(
        service.assertCanAccessEvent(userId, eventoDaB, 'view_event'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ===========================================================================
  // getMemberForOrganizerUser — primeiro vínculo do usuário
  // ===========================================================================
  describe('getMemberForOrganizerUser', () => {
    it('devolve o vínculo do usuário com a organização', async () => {
      const orgId = await seedOrganization(prisma);
      const userId = await seedUser(prisma, 'USER');
      await linkMember({ organizationId: orgId, userId, role: 'OWNER' });

      const member = await service.getMemberForOrganizerUser(userId);

      expect(member.userId).toBe(userId);
      expect(member.organizationId).toBe(orgId);
      expect(member.role).toBe('OWNER');
      expect(member.eventAccesses).toEqual([]);
    });

    it('erro quando o usuário não é organizador (sem nenhum vínculo)', async () => {
      const userId = await seedUser(prisma, 'USER');

      await expect(service.getMemberForOrganizerUser(userId)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ===========================================================================
  // buildOrganizerEventsWhere — filtro de eventos do painel (sem I/O, mas valida a regra)
  // ===========================================================================
  describe('buildOrganizerEventsWhere', () => {
    const base = (over: Partial<any> = {}) => ({
      id: 'm',
      organizationId: 'org-1',
      userId: 'u',
      role: 'EMPLOYEE' as const,
      permissions: null,
      restrictedToEvents: false,
      eventAccesses: [] as { eventId: string }[],
      ...over,
    });

    it('DONO vê a organização inteira (só filtra por organizationId)', () => {
      const where = service.buildOrganizerEventsWhere(base({ role: 'OWNER' }));
      expect(where).toEqual({ organizationId: 'org-1' });
    });

    it('funcionário NÃO restrito e sem eventos atribuídos vê todos da org', () => {
      const where = service.buildOrganizerEventsWhere(
        base({ restrictedToEvents: false, eventAccesses: [] }),
      );
      expect(where).toEqual({ organizationId: 'org-1' });
    });

    it('funcionário restrito e sem eventos atribuídos não vê nenhum (filtro impossível)', () => {
      const where = service.buildOrganizerEventsWhere(
        base({ restrictedToEvents: true, eventAccesses: [] }),
      );
      expect(where).toEqual({ organizationId: 'org-1', id: { in: [] } });
    });

    it('funcionário com lista de eventos vê apenas os IDs atribuídos', () => {
      const where = service.buildOrganizerEventsWhere(
        base({ eventAccesses: [{ eventId: 'e1' }, { eventId: 'e2' }] }),
      );
      expect(where).toEqual({ organizationId: 'org-1', id: { in: ['e1', 'e2'] } });
    });
  });

  // ===========================================================================
  // hasPermission — leitura pontual de permissão (papel + JSON)
  // ===========================================================================
  describe('hasPermission', () => {
    const member = (over: Partial<any> = {}) => ({
      id: 'm',
      organizationId: 'org-1',
      userId: 'u',
      role: 'EMPLOYEE' as const,
      permissions: null,
      restrictedToEvents: false,
      eventAccesses: [] as { eventId: string }[],
      ...over,
    });

    it('DONO tem todas as permissões, ignorando o JSON armazenado', () => {
      const m = member({ role: 'OWNER', permissions: { view_event: false } });
      expect(service.hasPermission(m, 'financial')).toBe(true);
      expect(service.hasPermission(m, 'view_event')).toBe(true);
    });

    it('funcionário com permissions null (legado) é tratado como acesso total', () => {
      const m = member({ role: 'EMPLOYEE', permissions: null });
      expect(service.hasPermission(m, 'financial')).toBe(true);
    });

    it('funcionário só tem o que o JSON libera', () => {
      const m = member({ role: 'EMPLOYEE', permissions: { view_event: true } });
      expect(service.hasPermission(m, 'view_event')).toBe(true);
      expect(service.hasPermission(m, 'financial')).toBe(false);
    });
  });
});
