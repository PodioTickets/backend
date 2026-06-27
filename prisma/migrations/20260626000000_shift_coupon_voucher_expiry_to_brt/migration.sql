-- Realinha a validade (expiryDate) de Coupon e Voucher do fim-do-dia em UTC para
-- o fim-do-dia em BRT (America/Sao_Paulo, UTC-3 fixo).
--
-- CONTEXTO
--   O `parseDate` (coupons/vouchers.service) gravava o dia civil escolhido pelo
--   organizador (YYYY-MM-DD) como `T23:59:59.999Z` — fim do dia em UTC, que é
--   20:59:59 BRT. Resultado: um cupom/voucher "expira 30/06" parava de funcionar
--   às 20:59 BRT do dia 30 (3h cedo), rejeitando compras feitas ainda no mesmo dia
--   no Brasil (ex.: 22h BRT) como "expirado". O código já foi corrigido para usar
--   `brtDayEndUtc` (= (dia+1)T02:59:59.999Z = 23:59:59.999 BRT); esta migração
--   conserta os registros JÁ existentes (formato legado).
--
-- O QUE FAZ
--   Soma +3h ao `expiryDate` APENAS dos registros no formato legado — identificados
--   pela hora exata 23:59:59.999 (todo expiryDate vem do branch date-only do
--   parseDate, então tem essa hora cravada). Registros já no formato novo têm hora
--   02:59:59.999 e NÃO são tocados.
--
-- IDEMPOTENTE
--   Após o shift, a hora vira 02:59:59.999 (dia seguinte) e deixa de casar com o
--   filtro 23:59:59.999 — rodar de novo é no-op (sem double-shift).
--
-- NÃO mexe em `status` (ACTIVE/EXPIRED): o status é recomputado na próxima edição e
--   a validade efetiva da compra usa a comparação de data (já corrigida no código).

UPDATE "Coupon"
SET "expiryDate" = "expiryDate" + INTERVAL '3 hours'
WHERE "expiryDate" IS NOT NULL
  AND "expiryDate"::time = TIME '23:59:59.999';

UPDATE "Voucher"
SET "expiryDate" = "expiryDate" + INTERVAL '3 hours'
WHERE "expiryDate" IS NOT NULL
  AND "expiryDate"::time = TIME '23:59:59.999';
