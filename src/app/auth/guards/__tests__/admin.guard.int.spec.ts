/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: a "portaria" das rotas de administrador — só deixa passar usuários que são
 *           ADMIN (ou equipe interna) e que estejam com a conta ativa.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Admin com conta ativa → entra.
 *    • Equipe interna (staff) com conta ativa → entra.
 *    • Usuário comum → barrado (precisa ser admin).
 *    • Admin com conta desativada → barrado.
 *    • Sem estar logado, ou usuário inexistente → barrado (não autorizado).
 *
 *  COMO CONFERIMOS:
 *    Teste DE VERDADE contra o banco de teste: criamos usuários reais (admin, comum,
 *    desativado) e conferimos quem a portaria deixa passar.
 * ============================================================================
 */
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AdminGuard } from '../admin.guard';
import { PrismaService } from '../../../../prisma/prisma.service';
import { createTestPrisma, resetDb } from '../../../../common/testing/integration-db';

describe('AdminGuard (integração, banco real)', () => {
  let prisma: PrismaService;
  let guard: AdminGuard;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    guard = new AdminGuard(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDb(prisma);
  });

  // cria um usuário real e devolve o ExecutionContext com ele "logado"
  const ctxForUser = async (over: any = {}) => {
    const user = await prisma.user.create({
      data: {
        email: `u-${Math.random()}@t.com`,
        password: 'x',
        firstName: 'F',
        lastName: 'L',
        role: 'USER',
        isActive: true,
        ...over,
      },
    });
    const request: any = { user: { id: user.id } };
    const ctx: any = { switchToHttp: () => ({ getRequest: () => request }) };
    return { ctx, request, user };
  };

  it('admin ativo entra (e marca o adminUser no pedido)', async () => {
    const { ctx, request } = await ctxForUser({ role: 'ADMIN' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.adminUser.role).toBe('ADMIN');
  });

  it('equipe interna (PODIOGO_STAFF) ativa entra', async () => {
    const { ctx } = await ctxForUser({ role: 'PODIOGO_STAFF' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('usuário comum é barrado', async () => {
    const { ctx } = await ctxForUser({ role: 'USER' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('admin com conta desativada é barrado', async () => {
    const { ctx } = await ctxForUser({ role: 'ADMIN', isActive: false });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('sem estar logado → não autorizado', async () => {
    const ctx: any = { switchToHttp: () => ({ getRequest: () => ({}) }) };
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('usuário inexistente → não autorizado', async () => {
    const ctx: any = {
      switchToHttp: () => ({ getRequest: () => ({ user: { id: '00000000-0000-4000-8000-000000000000' } }) }),
    };
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });
});
