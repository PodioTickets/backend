import {
  Controller, Get, Patch, Post, Delete, Body, Param, Query,
  UseGuards, DefaultValuePipe, ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags, ApiOperation, ApiBearerAuth,
  ApiQuery, ApiParam, ApiResponse, ApiBody,
} from '@nestjs/swagger';
import { IsArray, IsBoolean, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { AdminOrganizationsService, UpdateOrganizationDto } from './admin-organizations.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  AddMemberDto,
  CreateOrganizationDto,
  PatchMemberSettingsDto,
  PixKeyItemDto,
} from '../organizations/dto/organization.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { NoCache } from 'src/common/decorators/cache.decorator';

class UpdateOrganizationBodyDto implements UpdateOrganizationDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() tradeName?: string;
  @IsOptional() @IsString() document?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() whatsapp?: string;
  @IsOptional() @IsString() siteUrl?: string;
  @IsOptional() @IsString() instagram?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() zipCode?: string;
  @IsOptional() @IsString() street?: string;
  @IsOptional() @IsString() number?: string;
  @IsOptional() @IsString() neighborhood?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() ownerName?: string;
  @IsOptional() @IsString() pix?: string;
  @IsOptional() @IsString() pixKeyType?: string;
  @IsOptional() @IsString() bankName?: string;
  @IsOptional() @IsString() bankCode?: string;
  @IsOptional() @IsString() agency?: string;
  @IsOptional() @IsString() account?: string;
  @IsOptional() @IsString() accountType?: string;
  @IsOptional() @IsString() accountHolderName?: string;
  @IsOptional() @IsString() accountHolderDocument?: string;
  @IsOptional() @IsBoolean() @Transform(({ value }) => value === 'true' || value === true) isActive?: boolean;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PixKeyItemDto) pixKeys?: PixKeyItemDto[];
}

@ApiTags('Admin — Organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/v1/admin/organizations')
export class AdminOrganizationsController {
  constructor(
    private readonly adminOrganizationsService: AdminOrganizationsService,
    private readonly organizationsService: OrganizationsService,
  ) {}

  @Get()
  @NoCache()
  @ApiOperation({ summary: '[Admin] List all organizations' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Filter by name, trade name, email or document' })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean, description: 'Filter by active status' })
  @ApiResponse({
    status: 200,
    description: 'List of organizations with event count and status',
    schema: {
      example: {
        data: {
          organizations: [
            {
              id: 'uuid',
              name: 'Events Co.',
              tradeName: null,
              email: 'contato@eventsco.com',
              logoUrl: null,
              document: '12345678000195',
              phone: null,
              city: 'São Paulo',
              state: 'SP',
              isActive: true,
              createdAt: '2026-01-01T00:00:00.000Z',
              _count: { events: 5, members: 2 },
            },
          ],
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        },
      },
    },
  })
  getOrganizations(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('search') search?: string,
    @Query('isActive') isActive?: string,
  ) {
    const isActiveParsed = isActive === 'true' ? true : isActive === 'false' ? false : undefined;
    return this.adminOrganizationsService.getOrganizations({
      page,
      limit: Math.min(limit, 100),
      search,
      isActive: isActiveParsed,
    });
  }

  @Post()
  @ApiOperation({
    summary: '[Admin] Create a new organization',
    description:
      'Cria uma organização e atribui um usuário como OWNER. Permite duas formas: ' +
      '(1) `userId` de um usuário existente — promove o usuário a OWNER; ' +
      '(2) dados do owner (`ownerEmail`, `ownerPassword`, `ownerFirstName`, `ownerLastName` ' +
      'e opcionalmente `ownerPhone`/`ownerDocumentNumber`) — cria um novo usuário ORGANIZER ' +
      'e o atribui como OWNER. Tudo em uma única transação.',
  })
  @ApiBody({ type: CreateOrganizationDto })
  @ApiResponse({ status: 201, description: 'Organization created successfully' })
  @ApiResponse({ status: 400, description: 'Missing owner data, or user is already an owner of another organization' })
  @ApiResponse({ status: 404, description: 'User not found (when userId is provided)' })
  @ApiResponse({ status: 409, description: 'Email or document already in use by another ORGANIZER account' })
  createOrganization(@Body() dto: CreateOrganizationDto) {
    return this.organizationsService.createOrganization(dto);
  }

  @Get(':id')
  @NoCache()
  @ApiOperation({ summary: '[Admin] Get a single organization with full details' })
  @ApiParam({ name: 'id', type: String, description: 'Organization UUID' })
  @ApiResponse({ status: 200, description: 'Organization details with members and event count' })
  @ApiResponse({ status: 404, description: 'Organization not found' })
  getOrganization(@Param('id') id: string) {
    return this.adminOrganizationsService.getOrganization(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: '[Admin] Update an organization',
    description: 'Updates organization fields. Use `isActive: false` to deactivate.',
  })
  @ApiParam({ name: 'id', type: String, description: 'Organization UUID' })
  @ApiBody({ type: UpdateOrganizationBodyDto })
  @ApiResponse({ status: 200, description: 'Organization updated' })
  @ApiResponse({ status: 404, description: 'Organization not found' })
  updateOrganization(@Param('id') id: string, @Body() body: UpdateOrganizationBodyDto) {
    return this.adminOrganizationsService.updateOrganization(id, body);
  }

  // ── Members ────────────────────────────────────────────────────────────────

  @Get(':id/members/:memberUserId')
  @NoCache()
  @ApiOperation({ summary: '[Admin] Get member details' })
  @ApiParam({ name: 'id', type: String, description: 'Organization UUID' })
  @ApiParam({ name: 'memberUserId', type: String, description: 'User ID of the member' })
  @ApiResponse({ status: 200, description: 'Member details' })
  @ApiResponse({ status: 404, description: 'Member not found' })
  getMember(@Param('id') id: string, @Param('memberUserId') memberUserId: string) {
    return this.adminOrganizationsService.getMember(id, memberUserId);
  }

  @Post(':id/members')
  @ApiOperation({ summary: '[Admin] Add member to organization' })
  @ApiParam({ name: 'id', type: String, description: 'Organization UUID' })
  @ApiBody({ type: AddMemberDto })
  @ApiResponse({ status: 201, description: 'Member added' })
  @ApiResponse({ status: 404, description: 'Organization not found' })
  addMember(@Param('id') id: string, @Body() dto: AddMemberDto) {
    return this.organizationsService.addMemberAsAdmin(id, dto);
  }

  @Patch(':id/members/:memberUserId')
  @ApiOperation({ summary: '[Admin] Update member role/settings' })
  @ApiParam({ name: 'id', type: String, description: 'Organization UUID' })
  @ApiParam({ name: 'memberUserId', type: String, description: 'User ID of the member' })
  @ApiBody({ type: PatchMemberSettingsDto })
  @ApiResponse({ status: 200, description: 'Member updated' })
  @ApiResponse({ status: 404, description: 'Member not found' })
  updateMember(
    @Param('id') id: string,
    @Param('memberUserId') memberUserId: string,
    @Body() dto: PatchMemberSettingsDto,
  ) {
    return this.adminOrganizationsService.updateMember(id, memberUserId, dto);
  }

  @Delete(':id/members/:memberUserId')
  @ApiOperation({ summary: '[Admin] Remove member from organization' })
  @ApiParam({ name: 'id', type: String, description: 'Organization UUID' })
  @ApiParam({ name: 'memberUserId', type: String, description: 'User ID of the member' })
  @ApiResponse({ status: 200, description: 'Member removed' })
  @ApiResponse({ status: 404, description: 'Member not found' })
  removeMember(@Param('id') id: string, @Param('memberUserId') memberUserId: string) {
    return this.organizationsService.removeMemberAsAdmin(id, memberUserId);
  }
}
