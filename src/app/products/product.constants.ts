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

/**
 * Include padrão das leituras de produto: lista plana `variations` (todas as opções +
 * "Sem interesse", cada uma com `groupId`) e `variationGroups` com as opções de cada grupo,
 * ambos por sortOrder (contrato kit com várias variações).
 */
export const PRODUCT_VARIATIONS_INCLUDE = {
  variations: { orderBy: { sortOrder: 'asc' as const } },
  variationGroups: {
    orderBy: { sortOrder: 'asc' as const },
    include: { variations: { orderBy: { sortOrder: 'asc' as const } } },
  },
};

/**
 * Relações mínimas do Product p/ montar o rótulo das opções escolhidas numa inscrição
 * (`describeRegistrationProductVariations` → `variations` + `variationLabel`). Serve tanto
 * dentro de `select` quanto de `include` do produto.
 */
export const PRODUCT_VARIATION_LABEL_SELECT = {
  variations: { select: { id: true, name: true, groupId: true } },
  variationGroups: { select: { id: true, name: true, sortOrder: true } },
};
