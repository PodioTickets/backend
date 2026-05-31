import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  ParseUUIDPipe,
  Delete,
  Query,
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
  ApiQuery,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CouponsService } from './coupons.service';
import {
  CreateCouponDto,
  UpdateCouponDto,
  FilterCouponsDto,
  PreviewCouponQueryDto,
} from './dto/create-coupon.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { NoCache } from 'src/common/decorators/cache.decorator';

@ApiTags('Coupons')
@Controller('api/v1/coupons')
export class CouponsController {
  constructor(private readonly couponsService: CouponsService) {}

  @Post('events/:eventId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create coupon',
    description: 'Creates a new coupon for an event. Only the event organizer can create coupons.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiBody({ type: CreateCouponDto })
  @ApiResponse({ status: 201, description: 'Coupon created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - validation error or code already exists' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can create coupons' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  create(@Request() req, @Param('eventId') eventId: string, @Body() createCouponDto: CreateCouponDto) {
    return this.couponsService.create(req.user.id, eventId, createCouponDto);
  }

  @Get('events/:eventId')
  @UseGuards(JwtAuthGuard)
  @NoCache()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List coupons',
    description: 'Retrieves all coupons for a specific event with pagination and optional status filter',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 10)' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ACTIVE', 'INACTIVE', 'EXPIRED'],
    description: 'Filter by coupon status',
  })
  @ApiResponse({ status: 200, description: 'Coupons retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  findAll(@Request() req, @Param('eventId') eventId: string, @Query() filterDto: FilterCouponsDto) {
    return this.couponsService.findAll(eventId, filterDto);
  }

  // Rota pública: precede `GET /:id` no arquivo pra garantir que o router
  // do Nest case "events/:eventId/preview" antes de tentar bater como
  // "/:id". Ambas as ordens funcionam no Express, mas mantemos rotas mais
  // específicas primeiro por consistência com o resto do projeto.
  @Get('events/:eventId/preview')
  @UseGuards(OptionalJwtAuthGuard)
  @NoCache()
  @Throttle({ short: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Preview coupon OR voucher by code (público — funciona deslogado)',
    description:
      'Usado pela tela de checkout para exibir o cupom/voucher vindo do link (?coupon=/?voucher=) ANTES do login e da criação da order. `OptionalJwtAuthGuard`: anônimo recebe 200 (nunca 401). Resposta SEMPRE `{ data: preview | null }` (HTTP 200): código inexistente/expirado/inválido → `data: null`. `kind` discrimina o shape (`"coupon"` | `"voucher"`): cupom → couponType/type/value/applyToProducts; voucher → appliesTo (100% cortesia). Voucher tem prioridade sobre cupom de mesmo código. SOMENTE exibição: não valida CPF/uso/mínimo (isso é no apply/pay). AGE não entra aqui (ver age-eligibility). Código case-insensitive.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({
    name: 'code',
    required: false,
    description: 'Código do cupom OU voucher. Ausente/inválido → data: null',
    example: 'PODIO500',
  })
  @ApiResponse({
    status: 200,
    description:
      'Sempre 200. `{ data: null }` quando não há preview. Cupom: `{ kind:"coupon", code, couponType, type, value, applyToProducts }` (value: percentual 1-100 ou centavos no FIXED). Voucher: `{ kind:"voucher", code, appliesTo }`.',
  })
  previewByCode(
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Query() query: PreviewCouponQueryDto,
  ) {
    return this.couponsService.previewByCode(eventId, query.code);
  }

  // Rota específica: precede `GET /:id` (mesmo motivo do preview acima).
  // `OptionalJwtAuthGuard`: funciona com ou sem login — anônimo recebe
  // `applicable: false` em vez de 401, evitando quebrar a página do evento.
  @Get('events/:eventId/age-eligibility')
  @UseGuards(OptionalJwtAuthGuard)
  @NoCache()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Age coupon eligibility for the current user',
    description:
      'Retorna o cupom por idade (AGE) que será APLICADO ao usuário autenticado se ele prosseguir para o pagamento neste evento. A idade é avaliada na DATA DO EVENTO (mesma regra do checkout). Resultado é único (`appliedCoupon`): faixas etárias dos cupons AGE não se sobrepõem, então uma idade casa com no máximo um cupom. `appliesTo`/`minCartValue` do cupom são as condições da aplicação final (validadas no checkout). Anônimo ou usuário sem data de nascimento recebe `applicable: false` com `reason`. Não revela elegíveis nem contadores de uso.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiResponse({
    status: 200,
    description:
      'Elegibilidade avaliada. `data.applicable` (boolean), `data.age` (idade na data do evento ou null), `data.appliedCoupon` (o cupom que será aplicado — type/value/minAge/maxAge/appliesTo/minCartValue/... — ou null se nenhum).',
  })
  @ApiResponse({ status: 404, description: 'Event not found (code: EVENT_NOT_FOUND)' })
  getAgeEligibility(
    @Request() req,
    @Param('eventId', ParseUUIDPipe) eventId: string,
  ) {
    return this.couponsService.getApplicableAgeCoupons(eventId, req.user ?? null);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get coupon by ID',
    description: 'Retrieves a single coupon by its ID',
  })
  @ApiParam({ name: 'id', description: 'Coupon UUID' })
  @ApiResponse({ status: 200, description: 'Coupon retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Coupon not found' })
  findOne(@Param('id') id: string) {
    return this.couponsService.findOne(id);
  }

  @Patch('events/:eventId/:couponId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update coupon',
    description: 'Updates a coupon. Only the event organizer can update it. Cannot update coupons that have been used.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'couponId', description: 'Coupon UUID' })
  @ApiBody({ type: UpdateCouponDto })
  @ApiResponse({ status: 200, description: 'Coupon updated successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - validation error or coupon already used' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can update coupons' })
  @ApiResponse({ status: 404, description: 'Coupon not found' })
  update(
    @Request() req,
    @Param('eventId') eventId: string,
    @Param('couponId') couponId: string,
    @Body() updateCouponDto: UpdateCouponDto,
  ) {
    return this.couponsService.update(req.user.id, eventId, couponId, updateCouponDto);
  }

  @Delete('events/:eventId/:couponId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete coupon',
    description: 'Deletes a coupon. Only the event organizer can delete it. Cannot delete coupons that have been used.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'couponId', description: 'Coupon UUID' })
  @ApiResponse({ status: 200, description: 'Coupon deleted successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - coupon already used' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can delete coupons' })
  @ApiResponse({ status: 404, description: 'Coupon not found' })
  remove(@Request() req, @Param('eventId') eventId: string, @Param('couponId') couponId: string) {
    return this.couponsService.remove(req.user.id, eventId, couponId);
  }
}
