import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  Req,
} from '@nestjs/common';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

// 🔥 Controller atualizado - hot reload testado com sucesso!
import { SellItemDto } from './dto/sell-item.dto';
import { updateConfigUserDto } from './dto/user-items-response.dto';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiBody,
} from '@nestjs/swagger';
import { MFAService } from '../../common/services/mfa.service';
import { NoCache } from 'src/common/decorators/cache.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';

@ApiTags('User')
@Controller('api/v1/user')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly mfaService: MFAService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, AdminGuard)
  create(@Body() createUserDto: CreateUserDto) {
    return this.userService.create(createUserDto);
  }

  @Get()
  @NoCache()
  @UseGuards(JwtAuthGuard, AdminGuard)
  findAll(@Query('page') page?: string, @Query('limit') limit?: string) {
    console.log('🔥 HOT RELOAD: Método findAll chamado!');
    const pageNum = page ? parseInt(page) : 1;
    const limitNum = limit ? parseInt(limit) : 50;
    if (pageNum < 1) throw new Error('Página deve ser maior que 0');
    if (limitNum < 1 || limitNum > 100) {
      throw new Error('Limite deve estar entre 1 e 100');
    }
    if (limitNum > 100) throw new Error('Limite deve estar entre 1 e 100');
    return this.userService.findAll({ page: pageNum, limit: limitNum });
  }

  @Get(':id')
  @NoCache()
  @UseGuards(JwtAuthGuard, AdminGuard)
  findOne(@Param('id') id: string) {
    return this.userService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.userService.update(id, updateUserDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  remove(@Param('id') id: string) {
    return this.userService.remove(id);
  }

  // @Post(':id/promote')
  // @UseGuards(JwtAuthGuard, AdminGuard)
  // @ApiOperation({
  //   summary: 'Promover usuário a admin',
  //   description:
  //     'Promove um usuário regular para administrador. Apenas admins ativos podem executar esta operação.',
  // })
  // @ApiParam({
  //   name: 'id',
  //   description: 'ID do usuário a ser promovido',
  //   example: 'cmfewspvf0000bqbgfeee6kux',
  // })
  // async promoteToAdmin(@Param('id') userId: string, @Req() req: any) {
  //   const requesterId = req.user?.id;
  //   return await this.userService.promoteToAdmin(userId, requesterId);
  // }

  @Post('mfa/setup')
  @ApiOperation({
    summary: 'Configurar MFA para o usuário',
    description:
      'Gera um secret TOTP e QR code para configuração do autenticador',
  })
  async setupMFA(@Req() req: any) {
    try {
      const user = req.user;
      if (!user) {
        return {
          success: false,
          message: 'User not authenticated',
          error: 'UNAUTHENTICATED',
        };
      }

      const mfaData = this.mfaService.generateTOTPSecret(
        user.id,
        user.email || user.username,
      );

      return {
        success: true,
        data: mfaData,
        message: 'MFA setup generated successfully',
      };
    } catch (error) {
      return {
        success: false,
        message: `MFA setup failed: ${error.message}`,
        error: 'MFA_SETUP_FAILED',
      };
    }
  }

  @Post('mfa/verify')
  @ApiOperation({
    summary: 'Verificar código MFA',
    description: 'Verifica se o código TOTP fornecido é válido',
  })
  @ApiBody({
    description: 'Dados para verificação MFA',
    schema: {
      type: 'object',
      properties: {
        secret: { type: 'string', example: 'JBSWY3DPEHPK3PXP' },
        token: { type: 'string', example: '123456' },
      },
      required: ['secret', 'token'],
    },
  })
  async verifyMFA(
    @Body() body: { secret: string; token: string },
    @Req() req: any,
  ) {
    try {
      const { secret, token } = body;

      if (!secret || !token) {
        return {
          success: false,
          message: 'Secret and token are required',
          error: 'MISSING_PARAMETERS',
        };
      }
      const tokenValidation = this.mfaService.validateTOTPToken(token);
      if (!tokenValidation.isValid) {
        return {
          success: false,
          message: tokenValidation.error,
          error: 'INVALID_TOKEN_FORMAT',
        };
      }

      const isValid = this.mfaService.verifyTOTPCode(secret, token);

      return {
        success: true,
        data: { verified: isValid },
        message: isValid
          ? 'MFA code verified successfully'
          : 'Invalid MFA code',
      };
    } catch (error) {
      return {
        success: false,
        message: `MFA verification failed: ${error.message}`,
        error: 'MFA_VERIFY_FAILED',
      };
    }
  }

  @Get('mfa/status')
  @ApiOperation({
    summary: 'Verificar status MFA do usuário',
    description: 'Retorna informações sobre o status atual do MFA do usuário',
  })
  @ApiResponse({
    status: 200,
    description: 'Status MFA obtido com sucesso',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'object',
          properties: {
            isRequired: { type: 'boolean', example: false },
            remainingTime: { type: 'number', example: 15 },
          },
        },
        message: {
          type: 'string',
          example: 'MFA status retrieved successfully',
        },
      },
    },
  })
  async getMFAStatus(@Req() req: any) {
    try {
      const user = req.user;
      if (!user) {
        return {
          success: false,
          message: 'User not authenticated',
          error: 'UNAUTHENTICATED',
        };
      }

      const isRequired = this.mfaService.isMFARequired(
        user.id,
        user.role || 'user',
      );
      const remainingTime = this.mfaService.getRemainingTime();

      return {
        success: true,
        data: {
          isRequired,
          remainingTime,
        },
        message: 'MFA status retrieved successfully',
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to get MFA status: ${error.message}`,
        error: 'MFA_STATUS_FAILED',
      };
    }
  }
}
