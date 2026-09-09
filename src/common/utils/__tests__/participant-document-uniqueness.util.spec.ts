import {
  collectParticipantDocuments,
  distinctDocuments,
  findAlreadyRegisteredSlots,
  findRepeatedDocumentSlots,
} from '../participant-document-uniqueness.util';

describe('participant-document-uniqueness.util', () => {
  describe('collectParticipantDocuments', () => {
    it('normaliza CPF formatado e cru para a mesma chave', () => {
      const docs = collectParticipantDocuments([
        { cpf: '123.456.789-00' },
        { documentNumber: '12345678900' },
      ]);
      expect(docs).toEqual([
        { slot: 0, clean: '12345678900' },
        { slot: 1, clean: '12345678900' },
      ]);
    });

    it('ignora os slots vazios que o reserve cria ate a quantidade reservada', () => {
      const docs = collectParticipantDocuments([{}, { cpf: '11122233344' }, null]);
      expect(docs).toEqual([{ slot: 1, clean: '11122233344' }]);
    });

    it('preserva o indice REAL do slot, nao a posicao na lista filtrada', () => {
      const docs = collectParticipantDocuments([{}, {}, { cpf: '11122233344' }]);
      expect(docs[0].slot).toBe(2);
    });

    it('aceita lista ausente', () => {
      expect(collectParticipantDocuments(undefined)).toEqual([]);
      expect(collectParticipantDocuments(null)).toEqual([]);
    });
  });

  describe('findRepeatedDocumentSlots', () => {
    it('acusa apenas as repeticoes, mantendo o primeiro slot fora', () => {
      const repeated = findRepeatedDocumentSlots([
        { slot: 0, clean: 'A' },
        { slot: 1, clean: 'A' },
        { slot: 2, clean: 'A' },
      ]);
      expect(repeated.map((r) => r.slot)).toEqual([1, 2]);
    });

    it('nao acusa nada quando todos os documentos sao distintos', () => {
      expect(
        findRepeatedDocumentSlots([
          { slot: 0, clean: 'A' },
          { slot: 1, clean: 'B' },
        ]),
      ).toEqual([]);
    });

    it('pega repeticao entre ingressos DIFERENTES (o caso que passava antes)', () => {
      // Os slots nao carregam o ticketId de proposito: a regra vale para o
      // evento inteiro, entao dois tipos de ingresso distintos repetem igual.
      const repeated = findRepeatedDocumentSlots([
        { slot: 0, clean: '12345678900' },
        { slot: 3, clean: '12345678900' },
      ]);
      expect(repeated.map((r) => r.slot)).toEqual([3]);
    });
  });

  describe('findAlreadyRegisteredSlots', () => {
    it('marca os slots cujo documento ja tem inscricao no evento', () => {
      const slots = findAlreadyRegisteredSlots(
        [
          { slot: 0, clean: 'A' },
          { slot: 1, clean: 'B' },
        ],
        ['B'],
      );
      expect(slots.map((s) => s.slot)).toEqual([1]);
    });

    it('ignora strings vazias vindas do participantCpfClean legado', () => {
      // Passaporte grava '' em participantCpfClean; sem o filtro, um slot sem
      // documento casaria com '' e o pedido seria recusado sem motivo.
      expect(findAlreadyRegisteredSlots([{ slot: 0, clean: 'A' }], ['', 'A'])).toHaveLength(1);
      expect(findAlreadyRegisteredSlots([{ slot: 0, clean: 'A' }], ['', 'B'])).toHaveLength(0);
    });
  });

  describe('distinctDocuments', () => {
    it('deduplica para a consulta nao repetir valor no IN', () => {
      expect(
        distinctDocuments([
          { slot: 0, clean: 'A' },
          { slot: 1, clean: 'A' },
          { slot: 2, clean: 'B' },
        ]),
      ).toEqual(['A', 'B']);
    });
  });
});
