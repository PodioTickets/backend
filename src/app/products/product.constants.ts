/**
 * Constantes de domínio de produtos compartilhadas entre módulos.
 * Arquivo neutro (sem imports de services) para evitar ciclos de dependência —
 * pode ser importado por ProductsService e TicketsService com segurança.
 */

/**
 * Nome da variação padrão "opt-out" criada automaticamente para produtos
 * NÃO obrigatórios. Representa "não quero este item" — deve permanecer
 * ilimitada (stock = 0) e fica de fora da sincronização de estoque por vagas.
 */
export const DEFAULT_NO_INTEREST_VARIATION_NAME = 'Sem interesse';
