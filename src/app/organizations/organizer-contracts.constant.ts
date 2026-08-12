/**
 * Contratos que o organizador aceita no auto-cadastro público (`signupOrganizer`).
 *
 * Fonte AUTORITATIVA (servidor) do id + versão gravados em `ContractAcceptance`.
 * Espelha `frontend/src/data/organizerContracts.ts` — ao publicar uma nova versão
 * dos documentos, atualize `version` aqui (o registro de aceite guarda a versão
 * vigente no momento do cadastro, servindo como prova da manifestação de vontade).
 */
export interface OrganizerContractRef {
  /** 'main' | 'antifraud' | 'cancellation' | 'transfer'. */
  id: string;
  /** Versão vigente exibida/aceita (ex.: '27/06/2026'). */
  version: string;
}

export const ORGANIZER_CONTRACTS: readonly OrganizerContractRef[] = [
  { id: 'main', version: '27/06/2026' },
  { id: 'antifraud', version: '27/06/2026' },
  { id: 'cancellation', version: '27/06/2026' },
  { id: 'transfer', version: '27/06/2026' },
];
