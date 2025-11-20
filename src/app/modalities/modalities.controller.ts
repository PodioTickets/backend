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
  CreateModalityGroupDto,
  UpdateModalityGroupDto,
  CreateModalityDto,
  UpdateModalityDto,
} from './dto/create-modality.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('Modalities')
@Controller('api/v1/modalities')
export class ModalitiesController {
  constructor(private readonly modalitiesService: ModalitiesService) {}

  // Modality Groups
  @Post('events/:eventId/groups')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  createGroup(
    @Request() req,
    @Param('eventId') eventId: string,
    @Body() createGroupDto: CreateModalityGroupDto,
  ) {
    return this.modalitiesService.createGroup(
      req.user.id,
      eventId,
      createGroupDto,
    );
  }

  @Patch('events/:eventId/groups/:groupId')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  updateGroup(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('groupId') groupId: string,
    @Body() updateGroupDto: UpdateModalityGroupDto,
  ) {
    return this.modalitiesService.updateGroup(
      req.user.id,
      eventId,
      groupId,
      updateGroupDto,
    );
  }

  @Delete('events/:eventId/groups/:groupId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  deleteGroup(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('groupId') groupId: string,
  ) {
    return this.modalitiesService.deleteGroup(req.user.id, eventId, groupId);
  }

  // Modalities
  @Post('events/:eventId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
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

  @Get('events/:eventId')
  findAll(@Param('eventId') eventId: string) {
    return this.modalitiesService.findAll(eventId);
  }

  @Get(':id')
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
