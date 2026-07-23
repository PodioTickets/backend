/**
 * ROTEIRO — admin lê as MESMAS permissões que o organizador
 * =========================================================
 * `AdminOrganizationsService.getMember` entregava a coluna JSON crua, deixando a
 * interpretação para o front do admin — que reidratava chaves ausentes com o
 * default e reexibia permissão já removida pelo organizador.
 *
 * Agora o cálculo é o mesmo do `organizations.service.getMemberDetail`
 * (`effectivePermissionsForMember` + `grantedPermissionKeys`). Adversarial:
 * mapa completo, mapa PARCIAL (o caso que quebrava), shape array legado,
 * `null` (= acesso total legado) e OWNER.
 */
import { AdminOrganizationsService } from '../admin-organizations.service';

describe('AdminOrganizationsService.getMember — permissões efetivas', () => {
  const build = (row: any) => {
    const findUnique = jest.fn().mockResolvedValue(row);
    const prisma: any = {
      getReadClient: () => ({ organizationMember: { findUnique } }),
      getWriteClient: () => ({}),
    };
    return new AdminOrganizationsService(prisma, {} as any);
  };

  const rowWith = (permissions: unknown, role: 'OWNER' | 'EMPLOYEE' = 'EMPLOYEE') => ({
    id: 'm-1',
    role,
    userId: 'u-1',
    permissions,
    user: { id: 'u-1', firstName: 'Ana', lastName: 'Lima' },
    eventAccesses: [{ eventId: 'evt-1' }],
  });

  const permissionsOf = async (row: any) => {
    const res = await build(row).getMember('org-1', 'u-1');
    return res.data.permissions;
  };

  it('devolve só as chaves concedidas de um mapa completo', async () => {
    const perms = await permissionsOf(
      rowWith({
        dashboard: false,
        financial: true,
        create_event: false,
        edit_event: false,
        view_event: true,
        coupons: false,
        pixel: false,
        notify: false,
      }),
    );

    expect(perms).toContain('financial');
    expect(perms).toContain('view_event');
    expect(perms).not.toContain('coupons');
    expect(perms).not.toContain('edit_event');
  });

  it('NÃO reexibe permissão ausente do mapa parcial (bug do painel admin)', async () => {
    // O organizador removeu tudo menos `financial`; o mapa gravado pode não
    // trazer as demais chaves. Antes, `view_event` voltava marcado por default.
    const perms = await permissionsOf(rowWith({ financial: true }));

    expect(perms).toContain('financial');
    expect(perms).not.toContain('view_event');
    expect(perms).not.toContain('coupons');
  });

  it('entende o shape ARRAY legado gravado por versões antigas do admin', async () => {
    const perms = await permissionsOf(rowWith(['coupons', 'notify']));

    expect(perms).toEqual(expect.arrayContaining(['coupons', 'notify']));
    expect(perms).not.toContain('financial');
  });

  it('`null` = nunca configurado → acesso total (mesma regra do organizador)', async () => {
    const perms = await permissionsOf(rowWith(null));

    expect(perms).toEqual(
      expect.arrayContaining(['financial', 'edit_event', 'view_event', 'coupons']),
    );
  });

  it('OWNER tem acesso total mesmo sem mapa gravado', async () => {
    const perms = await permissionsOf(rowWith(null, 'OWNER'));

    expect(perms).toContain('financial');
    expect(perms).toContain('create_event');
  });

  it('não vaza a coluna JSON crua no membro (só as chaves calculadas)', async () => {
    const res = await build(rowWith({ financial: true })).getMember('org-1', 'u-1');

    expect(res.data.member.permissions).toEqual(res.data.permissions);
    expect(res.data.eventIds).toEqual(['evt-1']);
  });
});
