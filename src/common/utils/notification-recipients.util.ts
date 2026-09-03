/**
 * Destinatários das notificações de evento do organizador.
 *
 * As notificações de auditoria (evento em análise, ajustes solicitados) vão
 * para o e-mail de contato da ORGANIZAÇÃO **e** para o e-mail do MEMBRO DONO
 * (role OWNER) — não é um fallback entre os dois: quem cadastrou um contato
 * institucional continua querendo que o dono saiba.
 *
 * Na prática os dois são quase sempre o mesmo endereço. A deduplicação compara
 * em minúsculas e sem espaços das pontas: sem isso "Contato@x.com" e
 * "contato@x.com" entrariam como dois destinatários no SendGrid e a mesma
 * pessoa receberia o aviso duas vezes.
 *
 * A caixa ORIGINAL da primeira ocorrência é preservada — só a COMPARAÇÃO é
 * insensível a maiúsculas. A parte local de um e-mail é case-sensitive pela
 * RFC 5321; normalizar o endereço enviado poderia quebrar servidores raros
 * que a respeitam.
 */
export function buildOrganizerNotificationRecipients(
  emails: ReadonlyArray<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  const recipients: string[] = [];

  for (const raw of emails) {
    const email = raw?.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(email);
  }

  return recipients;
}
