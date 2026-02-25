import { Controller, Get, Post, Body, Param, Delete, UseGuards, Request } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { RegistrationsService } from './registrations.service';
import { CreateRegistrationWithInvitedUserDto } from './dto/create-registration.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaymentsService } from '../payments/payments.service';

@ApiTags('Registrations')
@Controller('api/v1/registrations')
export class RegistrationsController {
  constructor(
    private readonly registrationsService: RegistrationsService,
    private readonly paymentsService: PaymentsService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create registration', description: 'Creates a new event registration for the authenticated user or an invited user' })
  @ApiBody({ type: CreateRegistrationWithInvitedUserDto })
  @ApiResponse({ status: 201, description: 'Registration created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - Invalid registration data or event closed' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Event, modality, or kit item not found' })
  create(@Request() req, @Body() createRegistrationDto: CreateRegistrationWithInvitedUserDto) {
    return this.registrationsService.create(req.user.id, createRegistrationDto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my registrations', description: 'Retrieves all registrations for the authenticated user' })
  @ApiResponse({ status: 200, description: 'Registrations retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  findUserRegistrations(@Request() req) {
    return this.registrationsService.findUserRegistrations(req.user.id);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get registration by ID', description: 'Retrieves a single registration by ID.' })
  @ApiParam({ name: 'id', description: 'Registration UUID' })
  @ApiResponse({ status: 200, description: 'Registration retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only registration owner can access' })
  @ApiResponse({ status: 404, description: 'Registration not found' })
  findOne(@Request() req, @Param('id') id: string) {
    return this.registrationsService.findOne(id, req.user.id);
  }

  @Get(':id/payment-details')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get payment details by registration ID',
    description: 'Retrieves complete payment details including buyer, payment, event, and organizer information. Accessible by registration owner or event organizer.',
  })
  @ApiParam({ name: 'id', description: 'Registration UUID' })
  @ApiResponse({ status: 200, description: 'Payment details retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Access denied' })
  @ApiResponse({ status: 404, description: 'Registration or payment not found' })
  getPaymentDetailsByRegistration(@Request() req, @Param('id') id: string) {
    return this.paymentsService.getPaymentDetails(id, 'registration', req.user.id);
  }

  @Delete(':id/cancel')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel registration', description: 'Cancels a registration. Only the registration owner can cancel it.' })
  @ApiParam({ name: 'id', description: 'Registration UUID' })
  @ApiResponse({ status: 200, description: 'Registration cancelled successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only registration owner can cancel' })
  @ApiResponse({ status: 404, description: 'Registration not found' })
  cancel(@Request() req, @Param('id') id: string) {
    return this.registrationsService.cancel(id, req.user.id);
  }
}

