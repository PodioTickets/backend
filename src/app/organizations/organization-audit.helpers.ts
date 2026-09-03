import { serializeAuditValue } from '../events/event-audit.helpers';

/**
 * Auditoria de edição de DADOS DA ORGANIZAÇÃO (`kind: 'ORGANIZATION_UPDATE'`).
 *
 * Mesmo formato do `EVENT_UPDATE`: registramos apenas os campos que MUDARAM,
 * como `{ field, old, new }`, para o log do admin/organizador exibir o diff.
 *
 * Segurança: campos sensíveis (documentos, dados bancários/PIX) têm o VALOR
 * mascarado no log — registramos QUE mudaram, sem expor o conteúdo (princípio do
 * menor privilégio; o log é lido por admin de plataforma e pelo dono da org).
 */

/** Rótulos curtos (pt-BR) para o texto do log. */
export const ORGANIZATION_UPDATE_FIELD_LABELS: Record<string, string> = {
  name: 'razão social',
  tradeName: 'nome fantasia',
  document: 'CPF/CNPJ',
  email: 'e-mail de contato',
  phone: 'telefone',
  whatsapp: 'WhatsApp',
  siteUrl: 'site',
  instagram: 'Instagram',
  description: 'descrição',
  fiscalEmail: 'e-mail fiscal',
  zipCode: 'CEP',
  street: 'rua',
  number: 'número',
  neighborhood: 'bairro',
  city: 'cidade',
  state: 'estado',
  ownerName: 'responsável',
  ownerDocument: 'CPF do responsável',
  bankName: 'banco',
  bankCode: 'código do banco',
  agency: 'agência',
  account: 'conta',
  accountType: 'tipo de conta',
  accountHolderName: 'titular da conta',
  accountHolderDocument: 'documento do titular',
  anticipationMonthlyRate: 'taxa mensal de antecipação',
  anticipationEnabled: 'antecipação habilitada',
  advisor: 'assessor responsável',
  pixKeys: 'chaves PIX',
};

/** Valor exibido no lugar de conteúdo sensível. */
export const ORGANIZATION_AUDIT_MASK = '••••';

/**
 * Campos cujo VALOR não deve aparecer no log (só registramos que mudaram).
 * Documentos e dados bancários — PII/financeiro sensível.
 */
const SENSITIVE_VALUE_FIELDS = new Set<string>([
  'document',
  'ownerDocument',
  'accountHolderDocument',
  'account',
  'agency',
  'bankCode',
]);

/** Só auditamos chaves conhecidas (evita vazar colunas internas por engano). */
const AUDITABLE_FIELDS = new Set<string>(
  Object.keys(ORGANIZATION_UPDATE_FIELD_LABELS),
);

/**
 * Diff entre o estado atual da organização e o payload de atualização (já sem
 * `pixKeys`, que é tratado à parte). Compara apenas as chaves presentes no
 * payload; ignora campos inalterados. Valores sensíveis são mascarados.
 */
export function diffOrganizationUpdateForAudit(
  before: Record<string, unknown>,
  data: Record<string, unknown>,
): Array<{ field: string; old: unknown; new: unknown }> {
  const out: Array<{ field: string; old: unknown; new: unknown }> = [];
  for (const key of Object.keys(data)) {
    if (!AUDITABLE_FIELDS.has(key)) continue;
    const rawNew = data[key];
    if (rawNew === undefined) continue;

    const oldVal = before[key];
    if (oldVal === rawNew) continue;
    // Normaliza null/undefined/"" e números vs strings para evitar diffs falsos.
    if (String(oldVal ?? '') === String(rawNew ?? '')) continue;

    const masked = SENSITIVE_VALUE_FIELDS.has(key);
    out.push({
      field: key,
      old: masked ? ORGANIZATION_AUDIT_MASK : serializeAuditValue(oldVal),
      new: masked ? ORGANIZATION_AUDIT_MASK : serializeAuditValue(rawNew),
    });
  }
  return out;
}
