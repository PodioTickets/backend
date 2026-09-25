import * as crypto from 'crypto';
import { Prisma } from '@prisma/client';

type TxClient = Pick<
  Prisma.TransactionClient,
  | 'user'
  | 'order'
  | 'payment'
  | 'registration'
  | 'eventWithdrawal'
  | 'eventAnticipation'
  | 'eventAudit'
>;

export type RemoveUserAccountResult = 'deleted' | 'deactivated';

/**
 * Remove a conta de um usuário SEM destruir o histórico que aponta para ela.
 *
 * Por que não basta `user.delete`: `Order.userId` (e `Payment.userId`) eram
 * `onDelete: Cascade`. A inscrição manual/cortesia do painel grava o COLABORADOR
 * como dono do pedido, então excluir a conta dele apagava Orders → Registrations →
 * ingressos/produtos/respostas das inscrições que ele criou. Saques e antecipações
 * são `Restrict` e faziam o `delete` estourar em vez de apagar.
 *
 * Regra:
 *   - Conta SEM histórico → hard-delete (nada a preservar).
 *   - Conta COM histórico → soft-delete: congela o comprador em `Order.buyerSnapshot`
 *     (lido por `EventsService.resolveOrderBuyer`), troca o e-mail por um anônimo
 *     (libera o `@@unique([email, accountType])` para um convite novo com o mesmo
 *     e-mail), neutraliza credenciais e marca `deletedAt` + `isActive=false`
 *     + `passwordChangedAt` (derruba tokens já emitidos).
 *
 * Diferente de `AuthService.deleteOwnAccount` (exclusão LGPD pedida pelo titular),
 * aqui o NOME é mantido: a conta vira âncora de auditoria ("quem criou a cortesia",
 * "quem pediu o saque") e o nome já consta na trilha de remoção da organização.
 *
 * Deve rodar DENTRO da transação do chamador — a contagem e a exclusão precisam
 * enxergar o mesmo estado. Os FKs `Restrict` do schema são a segunda camada: se um
 * pedido surgir entre a contagem e o delete, o banco recusa em vez de apagar.
 */
export async function removeUserAccountPreservingHistory(
  tx: TxClient,
  userId: string,
  now: Date = new Date(),
): Promise<RemoveUserAccountResult> {
  const [orders, payments, registrations, withdrawals, anticipations, audits] =
    await Promise.all([
      tx.order.count({ where: { userId } }),
      tx.payment.count({ where: { userId } }),
      tx.registration.count({
        where: { OR: [{ userId }, { invitedById: userId }] },
      }),
      tx.eventWithdrawal.count({ where: { requestedById: userId } }),
      tx.eventAnticipation.count({ where: { requestedById: userId } }),
      tx.eventAudit.count({ where: { auditedById: userId } }),
    ]);

  const hasHistory =
    orders + payments + registrations + withdrawals + anticipations + audits > 0;

  if (!hasHistory) {
    await tx.user.delete({ where: { id: userId } });
    return 'deleted';
  }

  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user) return 'deactivated';
  if (user.deletedAt) return 'deactivated'; // Já removida — idempotente.

  if (orders > 0) {
    // Não sobrescreve snapshot existente (conta já anonimizada antes).
    await tx.order.updateMany({
      where: { userId, buyerSnapshot: { equals: Prisma.DbNull } },
      data: {
        buyerSnapshot: {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone,
          documentNumber: user.documentNumber,
          avatarUrl: user.avatarUrl,
        } as Prisma.InputJsonValue,
      },
    });
  }

  // Inscrições legadas em que a conta é o PARTICIPANTE e ainda não há recibo: o
  // organizador leria documento/contato da conta viva, que vai ser limpa abaixo.
  // As chaves batem com `EventsService.resolveOrganizerParticipant`.
  await tx.registration.updateMany({
    where: { userId, receiptSnapshot: { equals: Prisma.DbNull } },
    data: {
      receiptSnapshot: {
        participant: {
          name: `${user.firstName} ${user.lastName}`.trim(),
          email: user.email,
          phone: user.phone,
          cpf: user.documentNumber,
          documentNumber: user.documentNumber,
          documentType: user.documentType,
          country: user.country,
          birthDate: user.dateOfBirth ? user.dateOfBirth.toISOString() : null,
          gender: user.gender,
        },
      } as Prisma.InputJsonValue,
    },
  });

  await tx.user.update({
    where: { id: userId },
    data: {
      email: `deleted-${user.id}@deleted.podioticket.local`,
      phone: null,
      reservePhone: null,
      documentType: null,
      documentNumber: null,
      documentNumberClean: null,
      googleId: null,
      googleEmail: null,
      totpSecret: null,
      mfaEnabled: false,
      // Senha inutilizável: não é um hash bcrypt válido → compare sempre falha.
      password: crypto.randomBytes(48).toString('hex'),
      isActive: false,
      deletedAt: now,
      passwordChangedAt: now,
    },
  });

  return 'deactivated';
}
