import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateQuestionDto, UpdateQuestionDto } from './dto/create-question.dto';

@Injectable()
export class QuestionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, eventId: string, createQuestionDto: CreateQuestionDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const question = await prismaWrite.question.create({
      data: {
        ...createQuestionDto,
        eventId,
        type: createQuestionDto.type || 'text',
        options: createQuestionDto.options ? (createQuestionDto.options as any) : null,
      },
    });

    return {
      message: 'Question created successfully',
      data: { question },
    };
  }

  async findAll(eventId: string) {
    const prismaRead = this.prisma.getReadClient();
    const questions = await prismaRead.question.findMany({
      where: { eventId },
      orderBy: { order: 'asc' },
    });

    return {
      message: 'Questions fetched successfully',
      data: { questions },
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

    return {
      message: 'Question fetched successfully',
      data: { question },
    };
  }

  async update(userId: string, eventId: string, questionId: string, updateQuestionDto: UpdateQuestionDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

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

    const updatedQuestion = await prismaWrite.question.update({
      where: { id: questionId },
      data: updateData,
    });

    return {
      message: 'Question updated successfully',
      data: { question: updatedQuestion },
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
    const prismaRead = this.prisma.getReadClient();

    const organizer = await prismaRead.organizer.findUnique({
      where: { userId },
    });

    if (!organizer) {
      throw new BadRequestException('User is not an organizer');
    }

    const event = await prismaRead.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (event.organizerId !== organizer.id) {
      throw new BadRequestException('User is not the organizer of this event');
    }
  }
}

