/**
 * Remove os dados de CONTATO da organização (email/phone) de objetos que vão pra
 * rotas de USUÁRIO/público. Contato do organizador não faz parte do contrato público —
 * só o painel do organizador/admin recebe esses campos (por caminhos próprios).
 *
 * Usado principalmente nos READS de `receiptSnapshot` históricos: snapshots antigos
 * congelaram `organization.{email,phone}` antes desta regra — o strip no read cobre
 * o retroativo sem reescrever snapshots (que são imutáveis por design).
 * Tolerante a null/undefined/shape inesperado (snapshots variam entre versões).
 */
export function stripOrganizationContact(org: unknown): Record<string, unknown> | null {
  if (!org || typeof org !== 'object') return null;
  const { email: _email, phone: _phone, ...safe } = org as Record<string, unknown>;
  return safe;
}
