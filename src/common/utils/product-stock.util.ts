/**
 * Controle de estoque e contagem de vendas de variações de produto.
 *
 * Fonte ÚNICA de verdade — usada pelo checkout (orders.service: hold/release) e pelo
 * finalize/estorno compartilhado (OrderFinalizationService: soldCount/reversão), espelhando
 * o par `quantity`/`availableQuantity` dos ingressos (TicketBatch).
 *
 * Modelo de campos em `ProductVariation`:
 * - `stock`          → LIMITE configurado pelo organizador. **0 = ilimitado** (sentinela).
 * - `availableStock` → restante disponível; decrementado no hold, restaurado no release.
 *                      Só faz sentido quando `stock > 0`.
 * - `soldCount`      → unidades vendidas (confirmadas no pay), revertidas no estorno.
 *
 * Invariante (em repouso, sem holds pendentes, para `stock > 0`): availableStock + soldCount = stock.
 *
 * Todas as escritas são SQL atômico (mesmo padrão dos ingressos), seguras sob concorrência.
 */

/**
 * Um produto SEGURA estoque quando NÃO é incluso-e-obrigatório ao mesmo tempo.
 * Incluso + obrigatório já é gated pela vaga do ingresso → não consome estoque próprio da
 * variação (só conta venda). Qualquer outro caso (opcional OU não-incluso) segura estoque.
 */
export function holdsStock(product: {
  isIncludedInTicket?: boolean | null;
  isRequired?: boolean | null;
}): boolean {
  return !(product?.isIncludedInTicket === true && product?.isRequired === true);
}

/**
 * Adquire (segura) `qty` unidades da variação de forma atômica. Só atua em estoque LIMITADO
 * (`stock > 0`); ilimitado é no-op. O guard `availableStock >= qty` impede oversell.
 * @returns nº de linhas afetadas — `0` significa esgotado (caller deve rejeitar).
 */
export function acquireVariationHold(tx: any, variationId: string, qty: number): Promise<number> {
  return tx.$executeRaw`
    UPDATE "ProductVariation"
    SET "availableStock" = "availableStock" - ${qty}, "updatedAt" = NOW()
    WHERE id = ${variationId}::uuid
      AND "stock" > 0
      AND "availableStock" >= ${qty}
  `;
}

/**
 * Libera (devolve) `qty` unidades ao restante. `LEAST(.., stock)` evita over-restore.
 * Só atua em estoque LIMITADO. Idempotente sob clamp.
 */
export function releaseVariationHold(tx: any, variationId: string, qty: number): Promise<number> {
  return tx.$executeRaw`
    UPDATE "ProductVariation"
    SET "availableStock" = LEAST("availableStock" + ${qty}, "stock"), "updatedAt" = NOW()
    WHERE id = ${variationId}::uuid
      AND "stock" > 0
  `;
}

/** Contabiliza a venda de `qty` unidades (incremento de soldCount). Vale para ilimitado também. */
export function incrementVariationSold(tx: any, variationId: string, qty: number): Promise<number> {
  return tx.$executeRaw`
    UPDATE "ProductVariation"
    SET "soldCount" = "soldCount" + ${qty}, "updatedAt" = NOW()
    WHERE id = ${variationId}::uuid
  `;
}

/** Reverte a venda de `qty` unidades (estorno/chargeback). `GREATEST(.., 0)` protege contra replay. */
export function decrementVariationSold(tx: any, variationId: string, qty: number): Promise<number> {
  return tx.$executeRaw`
    UPDATE "ProductVariation"
    SET "soldCount" = GREATEST("soldCount" - ${qty}, 0), "updatedAt" = NOW()
    WHERE id = ${variationId}::uuid
  `;
}
