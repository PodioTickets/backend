import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { MFAService } from '../../common/services/mfa.service';
import { UploadModule } from '../upload/upload.module';
import { EmailService } from '../../common/services/email.service';
import { CommonModule } from '../../common/common.module';

@Module({
  imports: [PrismaModule, UploadModule, ConfigModule, CommonModule],
  controllers: [UserController],
  providers: [UserService, MFAService, EmailService],
  exports: [UserService],
})
export class UserModule {}
