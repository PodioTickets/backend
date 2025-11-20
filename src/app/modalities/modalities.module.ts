import { Module } from '@nestjs/common';
import { ModalitiesService } from './modalities.service';
import { ModalitiesController } from './modalities.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ModalitiesController],
  providers: [ModalitiesService],
  exports: [ModalitiesService],
})
export class ModalitiesModule {}

