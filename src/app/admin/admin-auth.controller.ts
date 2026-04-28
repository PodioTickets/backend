import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { NoCache } from 'src/common/decorators/cache.decorator';

@ApiTags('Admin — Auth')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/v1/admin')
export class AdminAuthController {
  @Get('me')
  @NoCache()
  @ApiOperation({
    summary: '[Admin] Perfil do admin autenticado',
    description: 'Retorna os dados do usuário autenticado. Retorna 403 se o role não for ADMIN ou PODIOGO_STAFF.',
  })
  @ApiResponse({ status: 200, description: 'Admin profile' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin role required' })
  getMe(@Request() req: any) {
    const user = req.user;
    return {
      message: 'Admin profile fetched successfully',
      data: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        avatarUrl: user.avatarUrl,
      },
    };
  }
}
