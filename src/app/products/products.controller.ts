import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto, FilterProductsDto } from './dto/create-product.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NoCache } from 'src/common/decorators/cache.decorator';
import { getClientIp as clientIp } from '../../common/utils/client-ip.util';

function baseUrl(req: ExpressRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || '';
  return `${proto}://${host}`;
}

@ApiTags('Products')
@Controller('api/v1/products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) { }

  @Post('events/:eventId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create product',
    description: 'Creates a new product that can be linked to tickets',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiBody({ type: CreateProductDto })
  @ApiResponse({ status: 201, description: 'Product created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - validation error' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can create products' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  create(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('eventId') eventId: string,
    @Body() createProductDto: CreateProductDto,
  ) {
    return this.productsService.create(
      req.user.id,
      eventId,
      createProductDto,
      clientIp(req),
      baseUrl(req),
    );
  }

  @Get('events/:eventId')
  @NoCache()
  @ApiOperation({
    summary: 'List products',
    description:
      'Retrieves all products for a specific event with pagination. Results are ordered by name (A–Z), then by id for a stable sort across pages.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20)' })
  @ApiResponse({ status: 200, description: 'Products retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  findAll(
    @Request() req: ExpressRequest,
    @Param('eventId') eventId: string,
    @Query() filterDto: FilterProductsDto,
  ) {
    return this.productsService.findAll(eventId, filterDto, baseUrl(req));
  }

  @Get(':id')
  @NoCache()
  @ApiOperation({
    summary: 'Get product by ID',
    description: 'Retrieves a single product by its ID',
  })
  @ApiParam({ name: 'id', description: 'Product UUID' })
  @ApiResponse({ status: 200, description: 'Product retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  findOne(@Request() req: ExpressRequest, @Param('id') id: string) {
    return this.productsService.findOne(id, baseUrl(req));
  }

  @Patch('events/:eventId/:productId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update product',
    description: 'Updates a product. Cannot update products linked to sold tickets.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'productId', description: 'Product UUID' })
  @ApiBody({ type: UpdateProductDto })
  @ApiResponse({ status: 200, description: 'Product updated successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - validation error' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can update products' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  update(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('eventId') eventId: string,
    @Param('productId') productId: string,
    @Body() updateProductDto: UpdateProductDto,
  ) {
    return this.productsService.update(
      req.user.id,
      eventId,
      productId,
      updateProductDto,
      clientIp(req),
      baseUrl(req),
    );
  }

  @Delete('events/:eventId/:productId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete product',
    description: 'Deletes a product. Cannot delete products linked to tickets or kits.',
  })
  @ApiParam({ name: 'eventId', description: 'Event UUID' })
  @ApiParam({ name: 'productId', description: 'Product UUID' })
  @ApiResponse({ status: 200, description: 'Product deleted successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - product is linked to tickets or kits' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only organizer can delete products' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  remove(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('eventId') eventId: string,
    @Param('productId') productId: string,
  ) {
    return this.productsService.remove(
      req.user.id,
      eventId,
      productId,
      clientIp(req),
    );
  }
}
