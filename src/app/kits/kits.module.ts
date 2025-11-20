import { Module } from '@nestjs/common';
import { KitsService } from './kits.service';
import { KitsController } from './kits.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [KitsController],
  providers: [KitsService],
  exports: [KitsService],
})
export class KitsModule {}

