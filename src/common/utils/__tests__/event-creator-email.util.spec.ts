import { findEventCreatorMemberEmail } from '../event-creator-email.util';

/**
 * Colaborador que cria o evento também recebe os e-mails de auditoria (em análise,
 * ajustes, publicado). A fonte é a trilha de auditoria; só vale se ainda for membro.
 */
describe('findEventCreatorMemberEmail', () => {
  const createdAt = new Date('2026-09-14T12:00:00.000Z');
  const params = { organizationId: 'org-1', eventId: 'evt-1', eventCreatedAt: createdAt };

  const makeClient = (log: unknown, member: unknown) => ({
    organizationAuditLog: { findFirst: jest.fn().mockResolvedValue(log) },
    organizationMember: { findUnique: jest.fn().mockResolvedValue(member) },
  });

  it('devolve o e-mail do autor do log de criação quando ainda é membro', async () => {
    const client = makeClient(
      { actorUserId: 'user-colab' },
      { user: { email: 'colab@org.com' } },
    );

    await expect(findEventCreatorMemberEmail(client as any, params)).resolves.toBe('colab@org.com');

    const where = client.organizationAuditLog.findFirst.mock.calls[0][0].where;
    expect(where.organizationId).toBe('org-1');
    expect(where.AND[0]).toEqual({ metadata: { path: ['eventId'], equals: 'evt-1' } });
    expect(where.AND[1].OR).toEqual([
      { metadata: { path: ['kind'], equals: 'EVENT_CREATE' } },
      { metadata: { path: ['kind'], equals: 'EVENT_PUBLISH' } },
    ]);
    // Começa perto da criação do evento (usa o índice [organizationId, occurredAt]).
    expect(where.occurredAt.gte.getTime()).toBe(createdAt.getTime() - 60_000);
    expect(client.organizationAuditLog.findFirst.mock.calls[0][0].orderBy).toEqual({ occurredAt: 'asc' });
    expect(client.organizationMember.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId_userId: { organizationId: 'org-1', userId: 'user-colab' } },
      }),
    );
  });

  it('sem log (evento sem trilha) → null e nem consulta membro', async () => {
    const client = makeClient(null, null);
    await expect(findEventCreatorMemberEmail(client as any, params)).resolves.toBeNull();
    expect(client.organizationMember.findUnique).not.toHaveBeenCalled();
  });

  it('autor removido da organização → null', async () => {
    const client = makeClient({ actorUserId: 'user-saiu' }, null);
    await expect(findEventCreatorMemberEmail(client as any, params)).resolves.toBeNull();
  });

  it('falha de banco não derruba o envio → null', async () => {
    const client = {
      organizationAuditLog: { findFirst: jest.fn().mockRejectedValue(new Error('db down')) },
      organizationMember: { findUnique: jest.fn() },
    };
    await expect(findEventCreatorMemberEmail(client as any, params)).resolves.toBeNull();
  });
});
