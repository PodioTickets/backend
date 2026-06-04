/**
 * ROTEIRO — Escopo de desconto de PRODUTO por ingresso (applyToProducts)
 * =====================================================================
 *  CENÁRIO REAL (relato do usuário):
 *    Comprei 2 ingressos: um pra mim (ingresso A) e um pro meu amigo (ingresso B).
 *    Apliquei um cupom que vale SÓ pro meu ingresso (A). Cada um escolheu uma variação de
 *    produto. No resumo, o cupom estava descontando TAMBÉM o produto do meu amigo — errado.
 *    Deve descontar SÓ os produtos do participante cujo ingresso é o aplicável (o meu).
 *
 *  COMO O VÍNCULO FUNCIONA (sem coluna extra):
 *    - participante → ingresso: POSICIONAL. Expande reservedTickets por quantidade; o
 *      participante do slot i levou aquele ticketId (mesma regra do finalize da venda).
 *    - produto → participante: cada item de pendingProducts traz `participantEmail`.
 *    Logo: produto é descontável se o ingresso do seu participante ∈ appliesTo do cupom.
 *    O voucher (1 ingresso grátis) cobre só os produtos do participante do ingresso coberto.
 *
 *  Valores em centavos.
 */
import {
  buildParticipantTicketMap,
  computeApplicableProductsSubtotal,
  computeSlotParticipantProductsSubtotal,
  resolveApplicableTicketIds,
} from '../orders.service';

// slot 0 → ingresso A (eu), slot 1 → ingresso B (amigo)
const reservedTickets = [
  { ticketId: 'A', quantity: 1, unitPrice: 10000 },
  { ticketId: 'B', quantity: 1, unitPrice: 10000 },
];
const participants = [{ email: 'eu@x.com' }, { email: 'amigo@x.com' }];
const pendingProducts = [
  { productId: 'p1', participantEmail: 'eu@x.com', unitPrice: 5000, quantity: 1 },    // meu produto
  { productId: 'p2', participantEmail: 'amigo@x.com', unitPrice: 3000, quantity: 1 }, // produto do amigo
];

describe('Escopo de produto por ingresso (applyToProducts)', () => {
  describe('buildParticipantTicketMap (posicional, igual ao finalize)', () => {
    it('mapeia cada email ao ingresso do seu slot', () => {
      const map = buildParticipantTicketMap(reservedTickets, participants);
      expect(map.get('eu@x.com')).toBe('A');
      expect(map.get('amigo@x.com')).toBe('B');
    });

    it('ingresso com quantity>1 distribui slots em ordem', () => {
      const rt = [{ ticketId: 'A', quantity: 2, unitPrice: 100 }, { ticketId: 'B', quantity: 1, unitPrice: 100 }];
      const ps = [{ email: 'a@x' }, { email: 'b@x' }, { email: 'c@x' }];
      const map = buildParticipantTicketMap(rt, ps);
      expect(map.get('a@x')).toBe('A');
      expect(map.get('b@x')).toBe('A'); // 2ª unidade do ingresso A
      expect(map.get('c@x')).toBe('B');
    });

    it('slot vazio (sem email) é ignorado', () => {
      const map = buildParticipantTicketMap(reservedTickets, [{ email: 'eu@x.com' }, {}]);
      expect(map.get('eu@x.com')).toBe('A');
      expect(map.size).toBe(1);
    });
  });

  describe('resolveApplicableTicketIds', () => {
    it("'all' → todos os ingressos reservados", () => {
      expect([...resolveApplicableTicketIds('all', reservedTickets)].sort()).toEqual(['A', 'B']);
    });
    it('null → todos', () => {
      expect([...resolveApplicableTicketIds(null, reservedTickets)].sort()).toEqual(['A', 'B']);
    });
    it('lista → interseção com os reservados', () => {
      expect([...resolveApplicableTicketIds(JSON.stringify(['A']), reservedTickets)]).toEqual(['A']);
    });
  });

  describe('computeApplicableProductsSubtotal (cupom)', () => {
    const map = buildParticipantTicketMap(reservedTickets, participants);

    it('ROTEIRO: cupom no ingresso A desconta SÓ o meu produto, não o do amigo', () => {
      const applicable = resolveApplicableTicketIds(JSON.stringify(['A']), reservedTickets);
      expect(computeApplicableProductsSubtotal(pendingProducts, map, applicable)).toBe(5000); // só p1 (meu)
    });

    it('appliesTo=all → soma os produtos de todos os participantes', () => {
      const applicable = resolveApplicableTicketIds('all', reservedTickets);
      expect(computeApplicableProductsSubtotal(pendingProducts, map, applicable)).toBe(8000); // p1 + p2
    });

    it('cupom no ingresso B desconta só o produto do amigo', () => {
      const applicable = resolveApplicableTicketIds(JSON.stringify(['B']), reservedTickets);
      expect(computeApplicableProductsSubtotal(pendingProducts, map, applicable)).toBe(3000); // só p2
    });

    it('produto sem participante mapeável não entra', () => {
      const orphan = [{ productId: 'p9', participantEmail: 'ninguem@x.com', unitPrice: 9999, quantity: 1 }];
      const applicable = resolveApplicableTicketIds('all', reservedTickets);
      expect(computeApplicableProductsSubtotal(orphan, map, applicable)).toBe(0);
    });

    it('respeita quantity do produto', () => {
      const multi = [{ productId: 'p1', participantEmail: 'eu@x.com', unitPrice: 5000, quantity: 3 }];
      const applicable = resolveApplicableTicketIds(JSON.stringify(['A']), reservedTickets);
      expect(computeApplicableProductsSubtotal(multi, map, applicable)).toBe(15000);
    });
  });

  describe('computeSlotParticipantProductsSubtotal (voucher = ingresso coberto)', () => {
    it('voucher no slot 0 (meu ingresso) → só os meus produtos', () => {
      expect(computeSlotParticipantProductsSubtotal(pendingProducts, participants, 0)).toBe(5000);
    });
    it('voucher no slot 1 (amigo) → só os produtos do amigo', () => {
      expect(computeSlotParticipantProductsSubtotal(pendingProducts, participants, 1)).toBe(3000);
    });
    it('slot -1 (nenhuma unidade aplicável) → 0', () => {
      expect(computeSlotParticipantProductsSubtotal(pendingProducts, participants, -1)).toBe(0);
    });
    it('slot de participante sem email → 0', () => {
      expect(computeSlotParticipantProductsSubtotal(pendingProducts, [{ email: 'eu@x.com' }, {}], 1)).toBe(0);
    });
  });
});
