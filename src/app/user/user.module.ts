import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { MFAService } from '../../common/services/mfa.service';
import { UploadModule } from '../upload/upload.module';

@Module({
  imports: [PrismaModule, UploadModule],
  controllers: [UserController],
  providers: [UserService, MFAService],
  exports: [UserService],
})
export class UserModule {}
