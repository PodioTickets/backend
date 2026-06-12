/**
 * reconcile-included-required-stock.ts
 *
 * Comando one-off (manual) — reconcilia o `availableStock` das variações de produtos
 * INCLUSO + OBRIGATÓRIO depois da feature que passou a SEGURAR estoque também nesse caso
 * (2026-06-11, `holdsStock` agora = true p/ todos).
 *
 * CONTEXTO / POR QUE PRECISA
 *   No modelo ANTIGO, incluso+obrigatório NÃO segurava estoque: cada venda fazia `soldCount++`
 *   mas NUNCA decrementava `availableStock`. Resultado: a invariante de repouso
 *       availableStock + soldCount + holdsPendentes == stock
 *   ficou VIOLADA p/ esses produtos (availableStock "inflado" — em geral == stock, ignorando as
 *   vendas passadas). A partir da feature, novas compras decrementam corretamente, mas o ponto
 *   de partida segue inflado. Este comando corrige o baseline:
 *       availableStock := clamp(stock - soldCount - holdsPendentes, 0, stock)
 *
 *   O termo `holdsPendentes` (reservas em pedidos PENDING que JÁ decrementaram availableStock,
 *   itens com `stockHeld=true`) é OBRIGATÓRIO no cálculo — sem ele, devolveríamos unidades que
 *   estão reservadas agora e abriríamos brecha de oversell.
 *
 * ESCOPO
 *   SÓ variações de produto incluso+obrigatório com estoque LIMITADO (`stock > 0`).
 *   `stock = 0` é ILIMITADO → sem semântica de availableStock, é pulado.
 *   Outros produtos (opcional/não-incluso) já eram rastreados certo → fora do escopo.
 *
 * ⚠️ QUANDO RODAR (importante)
 *   Rode DEPOIS do deploy da feature E depois de a JANELA DE EXPIRAÇÃO do checkout escoar
 *   (~quando não restar nenhum pedido PENDING criado ANTES do deploy). Pedidos que estavam
 *   PENDING no momento do deploy têm `stockHeld=false` congelado p/ esses itens; se um deles
 *   PAGAR após o deploy, o finalize fará `soldCount++` sem decrementar availableStock (re-inflando).
 *   Esperar esses resolverem (pagar/expirar) garante que a correção não seja desfeita.
 *   O comando é IDEMPOTENTE — pode reexecutar com segurança.
 *
 * SEGURANÇA / DECISÕES
 *   - Dry-run por PADRÃO. Só aplica com `--apply`.
 *   - Na aplicação, o UPDATE é ATÔMICO e relê `stock`/`soldCount` ao vivo no banco
 *     (`GREATEST(LEAST(stock, stock - soldCount - <held>), 0)`), reduzindo corrida com vendas
 *     concorrentes (o `held` é um snapshot — rode em baixa concorrência p/ máxima precisão).
 *   - Linhas onde `stock - soldCount - held < 0` (vendeu MAIS que o limite atual — ex.: organizador
 *     baixou o limite abaixo do já vendido) são marcadas `[CLAMP<0]` e zeradas (avail=0): exigem
 *     atenção do organizador, mas o clamp evita número negativo.
 *
 * USO
 *   pnpm reconcile:included-required-stock                 # (default) DRY RUN — só mostra
 *   pnpm reconcile:included-required-stock --apply         # aplica
 *   pnpm reconcile:included-required-stock --apply --event=<eventId>   # restringe a um evento
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;
const eventArg = process.argv.find((a) => a.startsWith('--event='));
const EVENT_ID = eventArg ? eventArg.split('=')[1] : null;

type VarRow = {
  id: string;
  name: string;
  stock: number;
  availableStock: number;
  soldCount: number;
};

async function main() {
  console.log(
    `\nreconcile-included-required-stock  ${DRY_RUN ? '[DRY RUN]' : '[APPLY]'}${EVENT_ID ? `  event=${EVENT_ID}` : ''}\n`,
  );

  // 1. Variações alvo: produto incluso+obrigatório, estoque LIMITADO (stock > 0).
  const products = await prisma.product.findMany({
    where: {
      isIncludedInTicket: true,
      isRequired: true,
      ...(EVENT_ID ? { eventId: EVENT_ID } : {}),
    },
    select: {
      id: true,
      name: true,
      eventId: true,
      variations: {
        where: { stock: { gt: 0 } },
        select: { id: true, name: true, stock: true, availableStock: true, soldCount: true },
        orderBy: { sortOrder: 'asc' },
      },
    },
  });

  const targetVariationIds = new Set<string>();
  for (const p of products) for (const v of p.variations) targetVariationIds.add(v.id);

  console.log(
    `Produtos incluso+obrigatório: ${products.length}  |  variações limitadas (stock>0): ${targetVariationIds.size}\n`,
  );
  if (targetVariationIds.size === 0) {
    console.log('Nada a reconciliar.\n');
    return;
  }

  // 2. Holds ATIVOS: soma de quantidade (itens stockHeld=true) em pedidos PENDING, por variação.
  //    PAID = já virou venda (conta em soldCount); CANCELLED = já liberado. Só PENDING segura.
  const pendingOrders = await prisma.order.findMany({
    where: { status: 'PENDING', ...(EVENT_ID ? { eventId: EVENT_ID } : {}) },
    select: { id: true, pendingProducts: true },
  });

  const pendingHoldByVariation = new Map<string, number>();
  for (const o of pendingOrders) {
    const items = (o.pendingProducts as any[] | null) ?? [];
    for (const it of items) {
      if (it?.stockHeld !== true || !it?.variationId) continue;
      if (!targetVariationIds.has(it.variationId)) continue;
      pendingHoldByVariation.set(
        it.variationId,
        (pendingHoldByVariation.get(it.variationId) ?? 0) + (Number(it.quantity) || 1),
      );
    }
  }

  // 3. Computa o availableStock correto e aplica (ou só lista no dry-run).
  let changed = 0;
  let unchanged = 0;
  let clampedNeg = 0;

  for (const p of products) {
    for (const v of p.variations as VarRow[]) {
      const held = pendingHoldByVariation.get(v.id) ?? 0;
      const raw = v.stock - v.soldCount - held;
      const correct = Math.max(0, Math.min(v.stock, raw));
      const isClampNeg = raw < 0;

      if (correct === v.availableStock) {
        unchanged++;
        continue;
      }

      console.log(
        `  ${DRY_RUN ? 'DRY ' : 'OK  '} ${p.name} / ${v.name}  avail ${v.availableStock} → ${correct}` +
          `  (stock ${v.stock}, sold ${v.soldCount}, hold ${held})${isClampNeg ? '  [CLAMP<0 — vendeu mais que o limite!]' : ''}`,
      );
      if (isClampNeg) clampedNeg++;
      changed++;

      if (!DRY_RUN) {
        // Atômico: relê stock/soldCount ao vivo; `held` é o snapshot lido acima.
        await prisma.$executeRaw`
          UPDATE "ProductVariation"
          SET "availableStock" = GREATEST(LEAST("stock", "stock" - "soldCount" - ${held}), 0),
              "updatedAt" = NOW()
          WHERE id = ${v.id}::uuid AND "stock" > 0
        `;
      }
    }
  }

  console.log('\n──────────────────────────────────────────────');
  console.log(`${DRY_RUN ? 'Corrigiria' : 'Corrigidas'}: ${changed} variação(ões)`);
  console.log(`Já corretas (sem mudança): ${unchanged}`);
  if (clampedNeg > 0) {
    console.log(`⚠️  ${clampedNeg} variação(ões) com vendas ACIMA do limite atual (zeradas) — revisar com o organizador.`);
  }
  console.log('──────────────────────────────────────────────\n');
  if (DRY_RUN) console.log('Rode com --apply para aplicar.\n');
}

main()
  .catch((e) => {
    console.error('\n❌', e?.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
