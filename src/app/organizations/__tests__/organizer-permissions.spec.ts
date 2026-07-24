import {
  effectivePermissionsForMember,
  fullPermissionsMapFromJson,
  FULL_ORGANIZER_PERMISSIONS,
} from '../constants/organizer-permissions';

/**
 * `OrganizationMember.permissions` existe no banco em DOIS formatos:
 *  - MAPA `{ financial: true, ... }` — gravado pelo fluxo do organizador;
 *  - ARRAY `["financial", ...]` — legado, gravado pelo PATCH do painel admin.
 *
 * Regressão de SEGURANÇA: o array caía no `return null` do parser, e `null` (=
 * "nunca configurado") concede FULL_ORGANIZER_PERMISSIONS. Resultado: restringir
 * permissões pelo admin dava ACESSO TOTAL ao colaborador, e "editar de novo pela
 * aba do organizador" era o único jeito de a restrição valer.
 */
describe('organizer-permissions — formatos aceitos de `permissions`', () => {
  describe('fullPermissionsMapFromJson', () => {
    it('ARRAY legado: concede SOMENTE as chaves listadas', () => {
      const map = fullPermissionsMapFromJson(['view_event']);
      expect(map).not.toBeNull();
      expect(map!.view_event).toBe(true);
      expect(map!.financial).toBe(false);
      expect(map!.edit_event).toBe(false);
      expect(map!.create_event).toBe(false);
    });

    it('ARRAY vazio: não concede nada (≠ acesso total)', () => {
      const map = fullPermissionsMapFromJson([]);
      expect(map).not.toBeNull();
      expect(Object.values(map!).some(Boolean)).toBe(false);
    });

    it('ARRAY ignora chave desconhecida em vez de virar acesso total', () => {
      const map = fullPermissionsMapFromJson(['coupons', 'chave_inexistente']);
      expect(map!.coupons).toBe(true);
      expect(map!.financial).toBe(false);
    });

    it('MAPA canônico continua valendo', () => {
      const map = fullPermissionsMapFromJson({ financial: true, view_event: false });
      expect(map!.financial).toBe(true);
      expect(map!.view_event).toBe(false);
    });

    it('null = nunca configurado (o chamador decide o legado)', () => {
      expect(fullPermissionsMapFromJson(null)).toBeNull();
      expect(fullPermissionsMapFromJson(undefined)).toBeNull();
    });
  });

  describe('effectivePermissionsForMember', () => {
    it('EMPLOYEE com array ["view_event"] NÃO recebe acesso total', () => {
      const perms = effectivePermissionsForMember({
        role: 'EMPLOYEE',
        permissionsJson: ['view_event'],
      });

      expect(perms).not.toEqual(FULL_ORGANIZER_PERMISSIONS);
      expect(perms.view_event).toBe(true);
      expect(perms.financial).toBe(false);
      expect(perms.coupons).toBe(false);
      expect(perms.notify).toBe(false);
      // `dashboard` é derivado: ter QUALQUER permissão dá acesso ao painel.
      expect(perms.dashboard).toBe(true);
    });

    it('EMPLOYEE com array vazio não acessa nada', () => {
      const perms = effectivePermissionsForMember({
        role: 'EMPLOYEE',
        permissionsJson: [],
      });
      expect(Object.values(perms).some(Boolean)).toBe(false);
    });

    it('create_event implica editar e visualizar, mas NÃO acesso total', () => {
      const perms = effectivePermissionsForMember({
        role: 'EMPLOYEE',
        permissionsJson: ['create_event'],
      });
      // Implicadas: quem cria evento precisa editar e visualizar.
      expect(perms.create_event).toBe(true);
      expect(perms.edit_event).toBe(true);
      expect(perms.view_event).toBe(true);
      expect(perms.dashboard).toBe(true); // derivado
      // NÃO concede as demais — menor privilégio, paridade com o drawer.
      expect(perms.financial).toBe(false);
      expect(perms.coupons).toBe(false);
      expect(perms.pixel).toBe(false);
      expect(perms.notify).toBe(false);
      expect(perms).not.toEqual(FULL_ORGANIZER_PERMISSIONS);
    });

    it('OWNER tem acesso total qualquer que seja o formato armazenado', () => {
      for (const stored of [null, [], ['view_event'], { financial: false }]) {
        expect(
          effectivePermissionsForMember({ role: 'OWNER', permissionsJson: stored }),
        ).toEqual(FULL_ORGANIZER_PERMISSIONS);
      }
    });
  });
});
