import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateQuestionDto, UpdateQuestionDto } from './dto/create-question.dto';

@Injectable()
export class QuestionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, eventId: string, createQuestionDto: CreateQuestionDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();
    const appliesTo = await this.normalizeAndValidateAppliesTo(
      eventId,
      createQuestionDto.appliesTo,
      prismaRead,
    );

    const question = await prismaWrite.question.create({
      data: {
        ...createQuestionDto,
        eventId,
        type: createQuestionDto.type || 'text',
        options: createQuestionDto.options ? (createQuestionDto.options as any) : null,
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

  async findAll(eventId: string) {
    const prismaRead = this.prisma.getReadClient();
    const questions = await prismaRead.question.findMany({
      where: { eventId },
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

    if (!question || question.eventId !== eventId) {
      throw new NotFoundException('Question not found');
    }

    const updateData: any = { ...updateQuestionDto };
    if (updateQuestionDto.options) {
      updateData.options = updateQuestionDto.options as any;
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
      include: {
        answers: true,
      },
    });

    if (!question || question.eventId !== eventId) {
      throw new NotFoundException('Question not found');
    }

    if (question.answers.length > 0) {
      throw new BadRequestException('Cannot delete question with answers');
    }

    await prismaWrite.question.delete({
      where: { id: questionId },
    });

    return {
      message: 'Question deleted successfully',
    };
  }

  private async verifyOrganizerAccess(userId: string, eventId: string) {
    // Verificações de acesso críticas devem usar write client para consistência
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

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

