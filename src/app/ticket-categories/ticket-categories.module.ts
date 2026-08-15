import { Module } from '@nestjs/common';
import { TicketCategoriesController } from './ticket-categories.controller';
import { TicketCategoriesService } from './ticket-categories.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { CommonModule } from '../../common/common.module';

@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [TicketCategoriesController],
  providers: [TicketCategoriesService],
  exports: [TicketCategoriesService],
})
export class TicketCategoriesModule {}
