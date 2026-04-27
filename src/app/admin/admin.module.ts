import { Module } from '@nestjs/common';
import { AdminRepasseService } from './admin-repasse.service';
import { AdminRepasseController } from './admin-repasse.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AdminRepasseController],
  providers: [AdminRepasseService],
})
export class AdminModule {}
