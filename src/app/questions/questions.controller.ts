import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Request } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { QuestionsService } from './questions.service';
import { CreateQuestionDto, UpdateQuestionDto } from './dto/create-question.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('Questions')
@Controller('api/v1/questions')
export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

  @Post('events/:eventId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create question', description: 'Creates a new custom question for an event. Only the event organizer can create questions.' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiBody({ type: CreateQuestionDto })
  @ApiResponse({ status: 201, description: 'Question created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can create questions' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  create(@Request() req, @Param('eventId') eventId: string, @Body() createQuestionDto: CreateQuestionDto) {
    return this.questionsService.create(req.user.id, eventId, createQuestionDto);
  }

  @Get('events/:eventId')
  @ApiOperation({ summary: 'Get all questions for event', description: 'Retrieves all custom questions for a specific event' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiResponse({ status: 200, description: 'Questions retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  findAll(@Param('eventId') eventId: string) {
    return this.questionsService.findAll(eventId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get question by ID', description: 'Retrieves a single question by its ID' })
  @ApiParam({ name: 'id', description: 'Question UUID' })
  @ApiResponse({ status: 200, description: 'Question retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Question not found' })
  findOne(@Param('id') id: string) {
    return this.questionsService.findOne(id);
  }

  @Patch('events/:eventId/:questionId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update question', description: 'Updates a question. Only the event organizer can update it.' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'questionId', description: 'Question UUID' })
  @ApiBody({ type: UpdateQuestionDto })
  @ApiResponse({ status: 200, description: 'Question updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can update questions' })
  @ApiResponse({ status: 404, description: 'Question not found' })
  update(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('questionId') questionId: string,
    @Body() updateQuestionDto: UpdateQuestionDto,
  ) {
    return this.questionsService.update(req.user.id, eventId, questionId, updateQuestionDto);
  }

  @Delete('events/:eventId/:questionId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete question', description: 'Deletes a question. Only the event organizer can delete it.' })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'questionId', description: 'Question UUID' })
  @ApiResponse({ status: 200, description: 'Question deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can delete questions' })
  @ApiResponse({ status: 404, description: 'Question not found' })
  remove(@Request() req, @Param('eventId') eventId: string, @Param('questionId') questionId: string) {
    return this.questionsService.remove(req.user.id, eventId, questionId);
  }
}

