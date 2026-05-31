import { Controller, Get, Post, Body, Param, Delete, Patch, UseGuards, Request, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { RegistrationsService } from './registrations.service';
import { CreateRegistrationWithInvitedUserDto } from './dto/create-registration.dto';
import { FilterRegistrationsDto } from './dto/filter-registrations.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaymentsService } from '../payments/payments.service';
import { NoCache } from 'src/common/decorators/cache.decorator';

@ApiTags('Registrations')
@Controller('api/v1/registrations')
export class RegistrationsController {
  constructor(
    private readonly registrationsService: RegistrationsService,
    private readonly paymentsService: PaymentsService,
  ) { }

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
  @NoCache()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my registrations', description: 'Retrieves all registrations for the authenticated user with optional filtering and pagination' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20, max: 100)' })
  @ApiQuery({ name: 'status', required: false, enum: ['COMPLETED', 'CANCELLED', 'PENDING', 'CONFIRMED'], description: 'Filter by status' })
  @ApiResponse({ status: 200, description: 'Registrations retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  findUserRegistrations(@Request() req, @Query() filterDto: FilterRegistrationsDto) {
    return this.registrationsService.findUserRegistrations(req.user.id, filterDto);
  }

  @Get('me/:id')
  @NoCache()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my registration by ID', description: 'Retrieves complete registration details for the authenticated user' })
  @ApiParam({ name: 'id', description: 'Registration UUID' })
  @ApiResponse({ status: 200, description: 'Registration retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only registration owner can access' })
  @ApiResponse({ status: 404, description: 'Registration not found' })
  findMyRegistration(@Request() req, @Param('id') id: string) {
    return this.registrationsService.findMyRegistration(id, req.user.id);
  }

  @Patch(':registrationId/products/:productId/variation')
  @NoCache()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Alterar variação de produto incluso no ingresso',
    description: 'Permite ao comprador alterar a variação de um produto incluso no ingresso uma única vez, dentro do prazo configurado pelo organizador.',
  })
  @ApiParam({ name: 'registrationId', description: 'UUID da inscrição' })
  @ApiParam({ name: 'productId', description: 'UUID do produto' })
  @ApiBody({ schema: { type: 'object', properties: { variationId: { type: 'string', format: 'uuid' } }, required: ['variationId'] } })
  @ApiResponse({ status: 200, description: 'Variação atualizada com sucesso' })
  @ApiResponse({ status: 400, description: 'Alteração não permitida' })
  @ApiResponse({ status: 404, description: 'Inscrição ou produto não encontrado' })
  updateProductVariation(
    @Request() req,
    @Param('registrationId') registrationId: string,
    @Param('productId') productId: string,
    @Body('variationId') variationId: string,
  ) {
    return this.registrationsService.updateProductVariation(registrationId, productId, variationId, req.user.id);
  }

  @Get(':id')
  @NoCache()
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
  @NoCache()
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

