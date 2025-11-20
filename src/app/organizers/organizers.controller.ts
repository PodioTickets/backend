import { Controller, Get, Post, Body, Patch, Param, UseGuards, Request, BadRequestException } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { OrganizersService } from './organizers.service';
import { CreateOrganizerDto, UpdateOrganizerDto, ContactOrganizerDto } from './dto/create-organizer.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('Organizers')
@Controller('api/v1/organizers')
export class OrganizersController {
  constructor(
    private readonly organizersService: OrganizersService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create organizer profile', description: 'Creates an organizer profile for the authenticated user' })
  @ApiBody({ type: CreateOrganizerDto })
  @ApiResponse({ status: 201, description: 'Organizer profile created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 400, description: 'Bad request - User already has organizer profile' })
  create(@Request() req, @Body() createOrganizerDto: CreateOrganizerDto) {
    return this.organizersService.create(req.user.id, createOrganizerDto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my organizer profile', description: 'Retrieves the organizer profile of the authenticated user' })
  @ApiResponse({ status: 200, description: 'Organizer profile retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Organizer profile not found' })
  findOne(@Request() req) {
    return this.organizersService.findOne(req.user.id);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update my organizer profile', description: 'Updates the organizer profile of the authenticated user' })
  @ApiBody({ type: UpdateOrganizerDto })
  @ApiResponse({ status: 200, description: 'Organizer profile updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Organizer profile not found' })
  update(@Request() req, @Body() updateOrganizerDto: UpdateOrganizerDto) {
    return this.organizersService.update(req.user.id, updateOrganizerDto);
  }

  @Post(':organizerId/contact')
  @ApiOperation({ summary: 'Contact organizer', description: 'Sends a contact message to an organizer. Authentication is optional.' })
  @ApiParam({ name: 'organizerId', description: 'Organizer UUID' })
  @ApiBody({ type: ContactOrganizerDto })
  @ApiResponse({ status: 201, description: 'Contact message sent successfully' })
  @ApiResponse({ status: 404, description: 'Organizer not found' })
  async contactOrganizer(
    @Param('organizerId') organizerId: string,
    @Body() contactDto: ContactOrganizerDto,
    @Request() req?: any,
  ) {
    const userId = req?.user?.id || null;
    return this.organizersService.sendContactMessage(organizerId, {
      name: contactDto.name,
      email: contactDto.email,
      phone: contactDto.phone,
      message: contactDto.message,
      eventId: contactDto.eventId,
      userId,
    });
  }

  @Get(':organizerId/messages')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get organizer messages', description: 'Retrieves all contact messages for an organizer. Only the organizer can access their messages.' })
  @ApiParam({ name: 'organizerId', description: 'Organizer UUID' })
  @ApiResponse({ status: 200, description: 'Messages retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can access messages' })
  async getOrganizerMessages(@Request() req, @Param('organizerId') organizerId: string) {
    const organizer = await this.prisma.organizer.findUnique({
      where: { userId: req.user.id },
    });

    if (!organizer || organizer.id !== organizerId) {
      throw new BadRequestException('Access denied');
    }

    const messages = await this.prisma.contactMessage.findMany({
      where: { organizerId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        event: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      message: 'Messages fetched successfully',
      data: { messages },
    };
  }
}
