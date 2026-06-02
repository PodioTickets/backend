import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateQuestionDto, UpdateQuestionDto } from './dto/create-question.dto';

@Injectable()
export class QuestionsService {
  // Tipos que EXIGEM/aceitam opções. Validados: ≥1 opção não-vazia, sem duplicadas.
  private static readonly OPTION_TYPES = new Set(['select', 'multiple_choice']);
  // Tipos que NÃO têm opções: qualquer valor enviado é ignorado (armazenado como null).
  private static readonly NO_OPTION_TYPES = new Set(['text', 'true_false', 'number']);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Valida/normaliza `options` conforme o tipo da pergunta.
   *  - select / multiple_choice: exige array com **≥1 opção não-vazia**, sem duplicadas
   *    (comparadas já com trim). Retorna as opções com trim aplicado.
   *  - text / true_false / number: opções são ignoradas → retorna `null`.
   *  - demais tipos (legado: radio/checkbox/…): mantém o comportamento atual (passa o array
   *    recebido ou null), sem impor o piso, para não quebrar dados existentes.
   * Lança BadRequestException em opção vazia, duplicada ou ausência de opção válida.
   */
  private resolveQuestionOptions(type: string, options: unknown): string[] | null {
    if (QuestionsService.OPTION_TYPES.has(type)) {
      if (!Array.isArray(options) || options.length === 0) {
        throw new BadRequestException(
          `Perguntas do tipo "${type}" exigem ao menos 1 opção.`,
        );
      }
      const normalized: string[] = [];
      const seen = new Set<string>();
      for (const raw of options) {
        if (typeof raw !== 'string' || raw.trim() === '') {
          throw new BadRequestException('As opções não podem ser vazias.');
        }
        const value = raw.trim();
        if (seen.has(value)) {
          throw new BadRequestException(`Opção duplicada: "${value}".`);
        }
        seen.add(value);
        normalized.push(value);
      }
      return normalized;
    }

    if (QuestionsService.NO_OPTION_TYPES.has(type)) {
      return null;
    }

    // Tipos legados/desconhecidos: preserva o comportamento atual.
    return Array.isArray(options) ? (options as string[]) : null;
  }

  async create(userId: string, eventId: string, createQuestionDto: CreateQuestionDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();
    const appliesTo = await this.normalizeAndValidateAppliesTo(
      eventId,
      createQuestionDto.appliesTo,
      prismaRead,
    );

    const type = createQuestionDto.type || 'text';
    const options = this.resolveQuestionOptions(type, createQuestionDto.options);

    const question = await prismaWrite.question.create({
      data: {
        ...createQuestionDto,
        eventId,
        type,
        options: options as any,
        appliesTo,
      },
    });

    const transformedQuestion = {
      ...question,
      appliesTo: this.parseAppliesTo(question.appliesTo),
    };

    return {
      message: 'Question created successfully',
      data: { question: transformedQuestion },
    };
  }

  async findAll(eventId: string, userId?: string) {
    const prismaRead = this.prisma.getReadClient();

    const isOrganizer = userId ? await this.isOrganizerOfEvent(userId, eventId, prismaRead) : false;

    const questions = await prismaRead.question.findMany({
      where: { eventId, isActive: true },
      orderBy: { order: 'asc' },
    });
    const transformedQuestions = questions.map((question) => ({
      ...question,
      appliesTo: this.parseAppliesTo(question.appliesTo),
    }));

    return {
      message: 'Questions fetched successfully',
      data: { questions: transformedQuestions },
    };
  }

  async findOne(id: string) {
    const prismaRead = this.prisma.getReadClient();
    const question = await prismaRead.question.findUnique({
      where: { id },
      include: {
        event: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!question) {
      throw new NotFoundException('Question not found');
    }
    const transformedQuestion = {
      ...question,
      appliesTo: this.parseAppliesTo(question.appliesTo),
    };

    return {
      message: 'Question fetched successfully',
      data: { question: transformedQuestion },
    };
  }

  async update(userId: string, eventId: string, questionId: string, updateQuestionDto: UpdateQuestionDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const question = await prismaWrite.question.findUnique({
      where: { id: questionId },
    });

    if (!question || question.eventId !== eventId || !question.isActive) {
      throw new NotFoundException('Question not found');
    }

    const updateData: any = { ...updateQuestionDto };
    // Recalcula/valida options se o campo veio no payload OU se o tipo está mudando
    // (o tipo efetivo decide a regra; sem options no payload, revalida as já gravadas).
    if (updateQuestionDto.options !== undefined || updateQuestionDto.type !== undefined) {
      const effectiveType = updateQuestionDto.type ?? question.type;
      const optionsInput =
        updateQuestionDto.options !== undefined ? updateQuestionDto.options : question.options;
      updateData.options = this.resolveQuestionOptions(effectiveType, optionsInput) as any;
    }
    if (updateQuestionDto.appliesTo !== undefined) {
      updateData.appliesTo = await this.normalizeAndValidateAppliesTo(
        eventId,
        updateQuestionDto.appliesTo,
        prismaRead,
      );
    }

    const updatedQuestion = await prismaWrite.question.update({
      where: { id: questionId },
      data: updateData,
    });
    const transformedQuestion = {
      ...updatedQuestion,
      appliesTo: this.parseAppliesTo(updatedQuestion.appliesTo),
    };

    return {
      message: 'Question updated successfully',
      data: { question: transformedQuestion },
    };
  }

  async remove(userId: string, eventId: string, questionId: string) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const question = await prismaWrite.question.findUnique({
      where: { id: questionId },
      include: { answers: { take: 1 } },
    });

    if (!question || question.eventId !== eventId || !question.isActive) {
      throw new NotFoundException('Question not found');
    }

    if (question.answers.length > 0) {
      // Soft-delete: já tem respostas, mantém histórico
      await prismaWrite.question.update({
        where: { id: questionId },
        data: { isActive: false },
      });
    } else {
      // Hard-delete: sem respostas, remove permanentemente
      await prismaWrite.question.delete({
        where: { id: questionId },
      });
    }

    return {
      message: 'Question deleted successfully',
    };
  }

  private async isOrganizerOfEvent(userId: string, eventId: string, prisma: any): Promise<boolean> {
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { organizationId: true } });
    if (!event) return false;
    const member = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: event.organizationId, userId } },
    });
    return !!member;
  }

  private async verifyOrganizerAccess(userId: string, eventId: string) {
    // Verificações de acesso críticas devem usar write client para consistência
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Admin/staff bypassa checagens de organização
    const user = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (user?.role === 'ADMIN' || user?.role === 'PODIOGO_STAFF') return;

    const event = await prismaRead.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    // Verificar se o usuário é membro da organização do evento
    const member = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: event.organizationId,
          userId,
        },
      },
    });

    if (!member) {
      throw new BadRequestException('User is not a member of this event\'s organization');
    }
  }

  private parseAppliesTo(appliesTo: string | null): string | string[] | null {
    if (!appliesTo) return null;
    try {
      const parsed = JSON.parse(appliesTo);
      return Array.isArray(parsed) ? parsed : appliesTo;
    } catch {
      return appliesTo;
    }
  }

  private async normalizeAndValidateAppliesTo(
    eventId: string,
    appliesTo: string | string[] | undefined,
    prisma: any,
  ): Promise<string | null> {
    if (appliesTo === undefined) return null;

    if (appliesTo === 'all') return 'all';

    const ids = Array.isArray(appliesTo) ? appliesTo : [appliesTo];
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    if (uniqueIds.length === 0) {
      throw new BadRequestException('appliesTo must be "all" or a non-empty array of ticket IDs');
    }

    const tickets = await prisma.ticket.findMany({
      where: {
        id: { in: uniqueIds },
        eventId,
        isActive: true,
      },
      select: { id: true },
    });
    if (tickets.length !== uniqueIds.length) {
      throw new BadRequestException('One or more ticket IDs in appliesTo are invalid for this event');
    }

    return JSON.stringify(uniqueIds);
  }
}

