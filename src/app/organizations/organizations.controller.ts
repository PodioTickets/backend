import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
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
import { OrganizationsService } from './organizations.service';
import { CreateOrganizationDto, AddMemberDto, UpdateMemberRoleDto, UpdateOrganizationDto, UpdateOrganizationLogoDto } from './dto/organization.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BypassKeyGuard } from '../../common/guards/bypass-key.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { NoCache } from 'src/common/decorators/cache.decorator';

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

    return this.organizationsService.addMember(req.user.id, member.organizationId, addMemberDto);
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

    return this.organizationsService.removeMember(req.user.id, member.organizationId, memberUserId);
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
