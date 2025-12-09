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

import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
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
}
