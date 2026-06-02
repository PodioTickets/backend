/**
 * ROTEIRO — validação do campo `options` (create/update de pergunta)
 * ==================================================================
 * Regras:
 *  - select / multiple_choice: exige ARRAY com ≥1 opção NÃO-VAZIA, sem duplicadas
 *    (piso mudou de 2 → 1). Opções são armazenadas com trim.
 *  - text / true_false / number: options ignorado → armazenado como null.
 *  - rejeita opção vazia e duplicada (só o piso mudou de 2 → 1).
 *
 * Caso-motivador: checkbox único "Aceito os termos" (multiple_choice com 1 opção).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { QuestionsService } from '../questions.service';
import { PrismaService } from '../../../prisma/prisma.service';

describe('QuestionsService — validação de options (create/update)', () => {
  let service: QuestionsService;
  let create: jest.Mock;
  let update: jest.Mock;
  let findUnique: jest.Mock;

  beforeEach(async () => {
    create = jest.fn().mockImplementation(({ data }: any) => ({ id: 'q1', isActive: true, ...data }));
    update = jest.fn().mockImplementation(({ data }: any) => ({ id: 'q1', isActive: true, ...data }));
    findUnique = jest.fn();

    const db: any = {
      // role ADMIN → verifyOrganizerAccess dá bypass
      user: { findUnique: jest.fn().mockResolvedValue({ role: 'ADMIN' }) },
      event: { findUnique: jest.fn().mockResolvedValue({ id: 'evt-1', organizationId: 'org-1' }) },
      question: { create, update, findUnique },
    };
    const prisma: any = { getReadClient: () => db, getWriteClient: () => db };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [QuestionsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(QuestionsService);
  });

  const createQ = (dto: any) => service.create('admin-1', 'evt-1', dto);

  // ───────────────────────────────────────────── CREATE
  describe('create', () => {
    it('select com 1 opção → cria (piso é 1, não 2)', async () => {
      await createQ({ question: 'Tam.', type: 'select', options: ['Único'] });
      expect(create.mock.calls[0][0].data.options).toEqual(['Único']);
    });

    it('multiple_choice com 1 opção (checkbox "Aceito os termos") → cria', async () => {
      await createQ({ question: 'Termos', type: 'multiple_choice', options: ['Aceito os termos'] });
      expect(create.mock.calls[0][0].data.options).toEqual(['Aceito os termos']);
    });

    it('select sem options → 400', async () => {
      await expect(createQ({ question: 'X', type: 'select' })).rejects.toThrow(BadRequestException);
    });

    it('select com array vazio → 400', async () => {
      await expect(createQ({ question: 'X', type: 'select', options: [] })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('opção vazia ("") → 400', async () => {
      await expect(
        createQ({ question: 'X', type: 'select', options: ['A', ''] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('opção só com espaços → 400 (tratada como vazia)', async () => {
      await expect(
        createQ({ question: 'X', type: 'select', options: ['A', '   '] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('opções duplicadas → 400', async () => {
      await expect(
        createQ({ question: 'X', type: 'multiple_choice', options: ['A', 'A'] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('duplicada após trim → 400', async () => {
      await expect(
        createQ({ question: 'X', type: 'select', options: ['A ', ' A'] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('aplica trim e armazena normalizado', async () => {
      await createQ({ question: 'X', type: 'select', options: ['  P ', 'M'] });
      expect(create.mock.calls[0][0].data.options).toEqual(['P', 'M']);
    });

    it('text com options → ignora (armazena null)', async () => {
      await createQ({ question: 'Nome?', type: 'text', options: ['não', 'deveria'] });
      expect(create.mock.calls[0][0].data.options).toBeNull();
    });

    it('true_false e number → options null', async () => {
      await createQ({ question: 'TF', type: 'true_false', options: ['x'] });
      expect(create.mock.calls[0][0].data.options).toBeNull();
      await createQ({ question: 'N', type: 'number', options: ['x'] });
      expect(create.mock.calls[1][0].data.options).toBeNull();
    });
  });

  // ───────────────────────────────────────────── UPDATE
  describe('update', () => {
    const existing = (over: any = {}) => ({
      id: 'q1', eventId: 'evt-1', isActive: true, type: 'select', options: ['A', 'B'], ...over,
    });
    const upd = (dto: any) => service.update('admin-1', 'evt-1', 'q1', dto);

    it('atualiza options para 1 opção → ok', async () => {
      findUnique.mockResolvedValue(existing());
      await upd({ options: ['Único'] });
      expect(update.mock.calls[0][0].data.options).toEqual(['Único']);
    });

    it('options vazio em select → 400', async () => {
      findUnique.mockResolvedValue(existing());
      await expect(upd({ options: [] })).rejects.toThrow(BadRequestException);
    });

    it('options duplicadas → 400', async () => {
      findUnique.mockResolvedValue(existing());
      await expect(upd({ options: ['A', 'A'] })).rejects.toThrow(BadRequestException);
    });

    it('mudar type select→text (sem options) → limpa options (null)', async () => {
      findUnique.mockResolvedValue(existing());
      await upd({ type: 'text' });
      expect(update.mock.calls[0][0].data.options).toBeNull();
    });

    it('mudar type text→select sem options → 400 (precisa de ao menos 1)', async () => {
      findUnique.mockResolvedValue(existing({ type: 'text', options: null }));
      await expect(upd({ type: 'select' })).rejects.toThrow(BadRequestException);
    });

    it('editar só o enunciado (sem type/options) → NÃO toca em options', async () => {
      findUnique.mockResolvedValue(existing());
      await upd({ question: 'Novo enunciado' });
      expect('options' in update.mock.calls[0][0].data).toBe(false);
    });
  });
});
