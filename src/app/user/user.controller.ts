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
  UseInterceptors,
  UploadedFile,
  Request,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UploadService } from '../upload/upload.service';

import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiConsumes,
  ApiBearerAuth,
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
    private readonly uploadService: UploadService,
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

  @Post('avatar')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Upload avatar do usuário',
    description:
      'Faz upload de uma imagem de avatar e atualiza o perfil do usuário autenticado',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Arquivo de imagem (JPG, PNG, WEBP)',
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Arquivo não fornecido ou inválido',
  })
  @ApiResponse({
    status: 401,
    description: 'Não autorizado - usuário não autenticado',
  })
  async uploadAvatar(
    @Request() req,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Arquivo não fornecido');
    }

    try {
      // Fazer upload da imagem
      const avatarUrl = await this.uploadService.compressImage(file);

      // Atualizar o usuário com a nova URL do avatar
      const userId = req.user.id;
      const result = await this.userService.update(userId, { avatarUrl });

      return {
        message: 'Avatar atualizado com sucesso',
        data: result.data,
      };
    } catch (error) {
      throw new BadRequestException(
        `Erro ao fazer upload do avatar: ${error.message}`,
      );
    }
  }

  @Post(':id/avatar')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @UseInterceptors(FileInterceptor('file'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Upload avatar de outro usuário (Admin)',
    description:
      'Faz upload de uma imagem de avatar e atualiza o perfil de um usuário específico. Apenas administradores podem usar este endpoint.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Arquivo de imagem (JPG, PNG, WEBP)',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Avatar atualizado com sucesso',
  })
  @ApiResponse({
    status: 400,
    description: 'Arquivo não fornecido ou inválido',
  })
  @ApiResponse({
    status: 401,
    description: 'Não autorizado - usuário não autenticado',
  })
  @ApiResponse({
    status: 403,
    description: 'Acesso negado - privilégios de admin necessários',
  })
  async uploadAvatarForUser(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Arquivo não fornecido');
    }

    try {
      // Fazer upload da imagem
      const avatarUrl = await this.uploadService.compressImage(file);

      // Atualizar o usuário com a nova URL do avatar
      const result = await this.userService.update(id, { avatarUrl });

      return {
        message: 'Avatar atualizado com sucesso',
        data: result.data,
      };
    } catch (error) {
      throw new BadRequestException(
        `Erro ao fazer upload do avatar: ${error.message}`,
      );
    }
  }
}
