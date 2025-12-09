import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { ModalitiesService } from './modalities.service';
import {
  CreateModalityDto,
  UpdateModalityDto,
} from './dto/create-modality.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('Modalities')
@Controller('api/v1/modalities')
export class ModalitiesController {
  constructor(private readonly modalitiesService: ModalitiesService) {}

  @Get('templates')
  @ApiOperation({
    summary: 'Get all modality templates',
    description:
      'Retrieves all available modality templates that can be used when creating event modalities',
  })
  @ApiResponse({ status: 200, description: 'Templates retrieved successfully' })
  findAllTemplates() {
    return this.modalitiesService.findAllTemplates();
  }

  /**
   * Cria uma modalidade para um evento
   */
  @Post('events/:eventId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create modality for event',
    description:
      'Creates a new modality for an event. Can optionally use a modality template.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiBody({ type: CreateModalityDto })
  @ApiResponse({ status: 201, description: 'Modality created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - Only organizer can create modalities',
  })
  @ApiResponse({ status: 404, description: 'Event or template not found' })
  create(
    @Request() req,
    @Param('eventId') eventId: string,
    @Body() createModalityDto: CreateModalityDto,
  ) {
    return this.modalitiesService.create(
      req.user.id,
      eventId,
      createModalityDto,
    );
  }

  /**
   * Busca todas as modalidades de um evento
   */
  @Get('events/:eventId')
  @ApiOperation({
    summary: 'Get all event modalities',
    description: 'Retrieves all active modalities for a specific event',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiResponse({
    status: 200,
    description: 'Modalities retrieved successfully',
  })
  findAll(@Param('eventId') eventId: string) {
    return this.modalitiesService.findAll(eventId);
  }

  /**
   * Busca uma modalidade específica
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get modality by ID',
    description: 'Retrieves a single modality by its ID',
  })
  @ApiParam({ name: 'id', description: 'Modality UUID' })
  @ApiResponse({ status: 200, description: 'Modality retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Modality not found' })
  findOne(@Param('id') id: string) {
    return this.modalitiesService.findOne(id);
  }

  @Patch('events/:eventId/:modalityId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  update(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('modalityId') modalityId: string,
    @Body() updateModalityDto: UpdateModalityDto,
  ) {
    return this.modalitiesService.update(
      req.user.id,
      eventId,
      modalityId,
      updateModalityDto,
    );
  }

  @Delete('events/:eventId/:modalityId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  remove(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('modalityId') modalityId: string,
  ) {
    return this.modalitiesService.remove(req.user.id, eventId, modalityId);
  }
}
