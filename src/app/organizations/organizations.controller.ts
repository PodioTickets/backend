import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
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
import type { Request as ExpressRequest } from 'express';
import { OrganizationsService } from './organizations.service';
import {
  CreateOrganizationDto,
  AddMemberDto,
  UpdateMemberRoleDto,
  UpdateOrganizationDto,
  UpdateOrganizationLogoDto,
  PutMemberPermissionsDto,
  PutMemberEventsDto,
  PatchMemberSettingsDto,
  OrganizationAuditLogQueryDto,
  AdminAuditLogQueryDto,
  RecordOrganizerPageViewDto,
} from './dto/organization.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BypassKeyGuard } from '../../common/guards/bypass-key.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { NoCache } from 'src/common/decorators/cache.decorator';

function clientIp(req: ExpressRequest): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  if (Array.isArray(xff) && xff[0]) {
    return String(xff[0]).split(',')[0].trim();
  }
  return (req as ExpressRequest & { ip?: string }).ip || '';
}

@ApiTags('Organizations')
@Controller('api/v1/organizations')
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly prisma: PrismaService,
  ) { }

  @Get('me/check')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Check if user is organization member',
    description: 'Checks if the authenticated user is a member (OWNER or EMPLOYEE) of any organization. Useful for frontend middleware.',
  })
  @ApiResponse({ status: 200, description: 'Member status retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async checkMembership(@Request() req) {
    const prismaRead = this.prisma.getReadClient();

    const member = await prismaRead.organizationMember.findFirst({
      where: {
        userId: req.user.id,
      },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            tradeName: true,
          },
        },
      },
    });

    if (!member) {
      return {
        message: 'User is not a member of any organization',
        data: {
          isMember: false,
          role: null,
          organizationId: null,
          organization: null,
        },
      };
    }

    return {
      message: 'Member status retrieved successfully',
      data: {
        isMember: true,
        role: member.role,
        organizationId: member.organizationId,
        organization: member.organization,
      },
    };
  }

  @Get('me')
  @NoCache()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get my organization',
    description: 'Retrieves the organization of the authenticated organizer',
  })
  @ApiResponse({ status: 200, description: 'Organization retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Organizer not found' })
  getMyOrganization(@Request() req) {
    return this.organizationsService.getOrganizationByOrganizer(req.user.id);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update my organization',
    description: 'Updates the organization information of the authenticated organizer. Only the owner can update. Note: To update the logo, use the PATCH /api/v1/organizations/me/logo endpoint.',
  })
  @ApiBody({ type: UpdateOrganizationDto })
  @ApiResponse({ status: 200, description: 'Organization updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only owner can update' })
  @ApiResponse({ status: 404, description: 'Organization not found' })
  async updateMyOrganization(@Request() req, @Body() updateDto: UpdateOrganizationDto) {
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        userId: req.user.id,
        role: 'OWNER',
      },
    });

    if (!member) {
      throw new Error('Organizer not found');
    }

    return this.organizationsService.updateOrganization(req.user.id, member.organizationId, updateDto);
  }

  @Patch('me/logo')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update organization logo',
    description: 'Updates the logo/photo of the organization. Only the owner can update. The logoUrl should be a valid URL (e.g., from an upload endpoint).',
  })
  @ApiBody({ type: UpdateOrganizationLogoDto })
  @ApiResponse({ status: 200, description: 'Organization logo updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only owner can update' })
  @ApiResponse({ status: 404, description: 'Organization not found' })
  async updateMyOrganizationLogo(@Request() req, @Body() updateDto: UpdateOrganizationLogoDto) {
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        userId: req.user.id,
        role: 'OWNER',
      },
    });

    if (!member) {
      throw new Error('Organizer not found');
    }

    return this.organizationsService.updateOrganizationLogo(req.user.id, member.organizationId, updateDto.logoUrl);
  }

  @Get('me/members')
  @NoCache()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List organization members',
    description: 'Lists all members of the authenticated organizer\'s organization',
  })
  @ApiResponse({ status: 200, description: 'Members retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async listMyMembers(@Request() req) {
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        userId: req.user.id,
        role: 'OWNER',
      },
    });

    if (!member) {
      throw new Error('Organizer not found');
    }

    return this.organizationsService.listMembers(req.user.id, member.organizationId);
  }

  @Get('me/audit-logs')
  @NoCache()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List organization audit logs',
    description: 'Paginated audit trail for the organization. Only the owner can access.',
  })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 200, description: 'Audit logs retrieved successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only owner can view audit logs' })
  async listMyAuditLogs(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Query() query: OrganizationAuditLogQueryDto,
  ) {
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        userId: req.user.id,
        role: 'OWNER',
      },
    });

    if (!member) {
      throw new Error('Organizer not found');
    }

    return this.organizationsService.listOrganizationAuditLogs(
      req.user.id,
      member.organizationId,
      query,
    );
  }

  @Post('me/audit/page-view')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Record organizer panel page view',
    description:
      'Registers navigation to a panel route (e.g. `dashboard`). Repeated views of the same page within ~30 minutes are deduplicated (only the first is logged). Any organization member may call.',
  })
  @ApiBody({ type: RecordOrganizerPageViewDto })
  @ApiResponse({ status: 200, description: 'Recorded or deduplicated' })
  @ApiResponse({ status: 400, description: 'Invalid body' })
  @ApiResponse({ status: 403, description: 'Not an organization member' })
  async recordOrganizerPageView(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Body() body: RecordOrganizerPageViewDto,
  ) {
    return this.organizationsService.recordOrganizerPageView(
      req.user.id,
      body.pageKey,
      clientIp(req),
    );
  }

  @Post('me/members')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Add member to organization',
    description: 'Adds a new member to the organization. Only the owner can add members.',
  })
  @ApiBody({ type: AddMemberDto })
  @ApiResponse({ status: 201, description: 'Member added successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only owner can add members' })
  async addMember(@Request() req, @Body() addMemberDto: AddMemberDto) {
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        userId: req.user.id,
        role: 'OWNER',
      },
    });

    if (!member) {
      throw new Error('Organizer not found');
    }

    return this.organizationsService.addMember(
      req.user.id,
      member.organizationId,
      addMemberDto,
      clientIp(req),
    );
  }

  @Get('me/members/:memberUserId')
  @NoCache()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get organization member detail',
    description: 'Returns member row, effective permissions, allowed event ids and lastLoginAt.',
  })
  @ApiParam({ name: 'memberUserId', description: 'User ID of the member' })
  @ApiResponse({ status: 200, description: 'Member detail retrieved successfully' })
  async getMyMemberDetail(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('memberUserId') memberUserId: string,
  ) {
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        userId: req.user.id,
        role: 'OWNER',
      },
    });

    if (!member) {
      throw new Error('Organizer not found');
    }

    return this.organizationsService.getMemberDetail(
      req.user.id,
      member.organizationId,
      memberUserId,
    );
  }

  @Get('me/members/:memberUserId/permissions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get member permissions map' })
  @ApiParam({ name: 'memberUserId', description: 'User ID of the member' })
  @ApiResponse({ status: 200, description: 'Permissions retrieved successfully' })
  async getMyMemberPermissions(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('memberUserId') memberUserId: string,
  ) {
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        userId: req.user.id,
        role: 'OWNER',
      },
    });

    if (!member) {
      throw new Error('Organizer not found');
    }

    return this.organizationsService.getMemberPermissions(
      req.user.id,
      member.organizationId,
      memberUserId,
    );
  }

  @Put('me/members/:memberUserId/permissions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Replace member permissions (idempotent)' })
  @ApiParam({ name: 'memberUserId', description: 'User ID of the member' })
  @ApiBody({ type: PutMemberPermissionsDto })
  @ApiResponse({ status: 200, description: 'Permissions updated successfully' })
  async putMyMemberPermissions(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('memberUserId') memberUserId: string,
    @Body() dto: PutMemberPermissionsDto,
  ) {
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        userId: req.user.id,
        role: 'OWNER',
      },
    });

    if (!member) {
      throw new Error('Organizer not found');
    }

    return this.organizationsService.putMemberPermissions(
      req.user.id,
      member.organizationId,
      memberUserId,
      dto,
      clientIp(req),
    );
  }

  @Get('me/members/:memberUserId/events')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get member event whitelist (expanded to full list for owner/unrestricted employees)' })
  @ApiParam({ name: 'memberUserId', description: 'User ID of the member' })
  @ApiResponse({ status: 200, description: 'Event access retrieved successfully' })
  async getMyMemberEvents(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('memberUserId') memberUserId: string,
  ) {
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        userId: req.user.id,
        role: 'OWNER',
      },
    });

    if (!member) {
      throw new Error('Organizer not found');
    }

    return this.organizationsService.getMemberEvents(
      req.user.id,
      member.organizationId,
      memberUserId,
    );
  }

  @Put('me/members/:memberUserId/events')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Replace member event whitelist' })
  @ApiParam({ name: 'memberUserId', description: 'User ID of the member' })
  @ApiBody({ type: PutMemberEventsDto })
  @ApiResponse({ status: 200, description: 'Event access updated successfully' })
  async putMyMemberEvents(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('memberUserId') memberUserId: string,
    @Body() dto: PutMemberEventsDto,
  ) {
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        userId: req.user.id,
        role: 'OWNER',
      },
    });

    if (!member) {
      throw new Error('Organizer not found');
    }

    return this.organizationsService.putMemberEvents(
      req.user.id,
      member.organizationId,
      memberUserId,
      dto,
      clientIp(req),
    );
  }

  @Patch('me/members/:memberUserId/settings')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update member role, permissions and/or events in one request',
  })
  @ApiParam({ name: 'memberUserId', description: 'User ID of the member' })
  @ApiBody({ type: PatchMemberSettingsDto })
  @ApiResponse({ status: 200, description: 'Member settings updated successfully' })
  async patchMyMemberSettings(
    @Request() req: ExpressRequest & { user: { id: string } },
    @Param('memberUserId') memberUserId: string,
    @Body() dto: PatchMemberSettingsDto,
  ) {
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        userId: req.user.id,
        role: 'OWNER',
      },
    });

    if (!member) {
      throw new Error('Organizer not found');
    }

    return this.organizationsService.patchMemberSettings(
      req.user.id,
      member.organizationId,
      memberUserId,
      dto,
      clientIp(req),
    );
  }

  @Patch('me/members/:memberUserId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update member role',
    description: 'Updates the role of a member. Only the owner can update roles.',
  })
  @ApiParam({ name: 'memberUserId', description: 'User ID of the member' })
  @ApiBody({ type: UpdateMemberRoleDto })
  @ApiResponse({ status: 200, description: 'Member role updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only owner can update roles' })
  async updateMemberRole(
    @Request() req,
    @Param('memberUserId') memberUserId: string,
    @Body() updateDto: UpdateMemberRoleDto,
  ) {
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        userId: req.user.id,
        role: 'OWNER',
      },
    });

    if (!member) {
      throw new Error('Organizer not found');
    }

    return this.organizationsService.updateMemberRole(
      req.user.id,
      member.organizationId,
      memberUserId,
      updateDto,
      clientIp(req),
    );
  }

  @Delete('me/members/:memberUserId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Remove member from organization',
    description: 'Removes a member from the organization. Only the owner can remove members.',
  })
  @ApiParam({ name: 'memberUserId', description: 'User ID of the member' })
  @ApiResponse({ status: 200, description: 'Member removed successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - Only owner can remove members' })
  async removeMember(@Request() req, @Param('memberUserId') memberUserId: string) {
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        userId: req.user.id,
        role: 'OWNER',
      },
    });

    if (!member) {
      throw new Error('Organizer not found');
    }

    return this.organizationsService.removeMember(
      req.user.id,
      member.organizationId,
      memberUserId,
      clientIp(req),
    );
  }

  // ========== BYPASS ENDPOINTS ==========
  // Endpoints que requerem bypass code no header (x-api-bypass)

  @Post('admin/create')
  @UseGuards(BypassKeyGuard)
  @ApiOperation({
    summary: '[BYPASS] Create organization and assign owner',
    description: 'Creates a new organization and assigns a user as OWNER. Requires bypass code in header (x-api-bypass).',
  })
  @ApiBody({ type: CreateOrganizationDto })
  @ApiResponse({ status: 201, description: 'Organization created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing bypass key' })
  async createOrganizationAsAdmin(@Body() createDto: CreateOrganizationDto) {
    return this.organizationsService.createOrganization(createDto);
  }

  @Get('admin/audit-logs')
  @NoCache()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '[ADMIN] List all organization audit logs',
    description:
      'Paginated audit trail across organizations. Includes full metadata and `changeDetails` (field, label, old/new values) when the log has `metadata.changes`. Filter by organizationId and/or metadata.kind. (Checagem de papel admin temporariamente desabilitada.)',
  })
  @ApiQuery({ name: 'organizationId', required: false })
  @ApiQuery({ name: 'kind', required: false, description: 'e.g. EVENT_UPDATE, TICKET_UPDATE, PAGE_VIEW' })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 200, description: 'Audit logs retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async listAuditLogsAsAdmin(@Query() query: AdminAuditLogQueryDto) {
    return this.organizationsService.listAuditLogsAsAdmin(query);
  }

  @Get('admin/:organizationId')
  @UseGuards(BypassKeyGuard)
  @ApiOperation({
    summary: '[BYPASS] Get organization details',
    description: 'Retrieves organization details with all members. Requires bypass code in header (x-api-bypass).',
  })
  @ApiParam({ name: 'organizationId', description: 'Organization UUID' })
  @ApiResponse({ status: 200, description: 'Organization retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing bypass key' })
  async getOrganization(@Param('organizationId') organizationId: string) {
    const prismaRead = this.prisma.getReadClient();

    const organization = await prismaRead.organization.findUnique({
      where: { id: organizationId },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
              },
            },
          },
        },
        events: {
          select: {
            id: true,
            name: true,
            status: true,
            eventDate: true,
          },
        },
      },
    });

    if (!organization) {
      throw new Error('Organization not found');
    }

    return {
      message: 'Organization retrieved successfully',
      data: { organization },
    };
  }

  @Post('admin/:organizationId/members')
  @UseGuards(BypassKeyGuard)
  @ApiOperation({
    summary: '[BYPASS] Add member to organization',
    description: 'Adds a member to an organization. Requires bypass code in header (x-api-bypass).',
  })
  @ApiParam({ name: 'organizationId', description: 'Organization UUID' })
  @ApiBody({ type: AddMemberDto })
  @ApiResponse({ status: 201, description: 'Member added successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing bypass key' })
  async addMemberAsAdmin(
    @Param('organizationId') organizationId: string,
    @Body() addMemberDto: AddMemberDto,
  ) {
    return this.organizationsService.addMemberAsAdmin(organizationId, addMemberDto);
  }

  @Patch('admin/:organizationId/members/:memberUserId')
  @UseGuards(BypassKeyGuard)
  @ApiOperation({
    summary: '[BYPASS] Update member role',
    description: 'Updates the role of a member. Requires bypass code in header (x-api-bypass).',
  })
  @ApiParam({ name: 'organizationId', description: 'Organization UUID' })
  @ApiParam({ name: 'memberUserId', description: 'User ID of the member' })
  @ApiBody({ type: UpdateMemberRoleDto })
  @ApiResponse({ status: 200, description: 'Member role updated successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing bypass key' })
  async updateMemberRoleAsAdmin(
    @Param('organizationId') organizationId: string,
    @Param('memberUserId') memberUserId: string,
    @Body() updateDto: UpdateMemberRoleDto,
  ) {
    return this.organizationsService.updateMemberRoleAsAdmin(organizationId, memberUserId, updateDto);
  }

  @Delete('admin/:organizationId/members/:memberUserId')
  @UseGuards(BypassKeyGuard)
  @ApiOperation({
    summary: '[BYPASS] Remove member from organization',
    description: 'Removes a member from an organization. Requires bypass code in header (x-api-bypass).',
  })
  @ApiParam({ name: 'organizationId', description: 'Organization UUID' })
  @ApiParam({ name: 'memberUserId', description: 'User ID of the member' })
  @ApiResponse({ status: 200, description: 'Member removed successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing bypass key' })
  async removeMemberAsAdmin(
    @Param('organizationId') organizationId: string,
    @Param('memberUserId') memberUserId: string,
  ) {
    return this.organizationsService.removeMemberAsAdmin(organizationId, memberUserId);
  }
}
