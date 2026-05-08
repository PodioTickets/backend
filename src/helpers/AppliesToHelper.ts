/**
 * Helper centralizado pra parsear o campo `appliesTo` de cupons/vouchers/perguntas.
 *
 * Histórico do campo: armazenado como `String?` (TEXT) e pode ser:
 *   - `null` → não restringe
 *   - `'all'` → aplica a tudo (sentinel string)
 *   - `'<ticketId>'` → ID solto (string)
 *   - `'["id1","id2",...]'` → JSON array de IDs
 *
 * Otimizações:
 *   1. Fast-path por charCode evita try/catch no caso comum (ID solto), que é
 *      ~5x mais rápido que try/catch em hot path do checkout.
 *   2. Cache LRU pequeno (256 entries) por string raw. Justifica-se porque o
 *      mesmo cupom pode ser parseado várias vezes em fluxos diferentes do
 *      mesmo pedido (e em requisições concorrentes).
 */

const CACHE_LIMIT = 256;
const cache = new Map<string, string[]>();

/**
 * Sempre retorna `string[]`. Para `'all'` retorna `[]` (sem restrição) — caller
 * deve checar separadamente se precisa do sentinel.
 */
export function parseAppliesToArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  if (raw === 'all') return [];

  const cached = cache.get(raw);
  if (cached !== undefined) {
    return cached;
  }

  let result: string[];
  // Fast-path: se não começa com '[' não é JSON array
  if (raw.charCodeAt(0) !== 91) {
    result = [raw];
  } else {
    try {
      const parsed = JSON.parse(raw);
      result = Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === 'string')
        : [];
    } catch {
      result = [];
    }
  }

  if (cache.size >= CACHE_LIMIT) {
    // LRU manual: dropa o primeiro inserido (Map preserva ordem de inserção)
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(raw, result);
  return result;
}

/**
 * Retorna a forma "exposta na API": `null`, `string` ou `string[]`.
 * Mantém compat com o shape atual dos services de cupom/voucher/pergunta.
 */
export function parseAppliesToValue(
  raw: string | null | undefined,
): string | string[] | null {
  if (!raw) return null;
  if (raw.charCodeAt(0) !== 91) return raw;
  const arr = parseAppliesToArray(raw);
  return arr;
}
