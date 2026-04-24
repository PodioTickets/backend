import { Module } from '@nestjs/common';
import { RepasseService } from './repasse.service';
import { RepasseController } from './repasse.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [PrismaModule, OrganizationsModule],
  controllers: [RepasseController],
  providers: [RepasseService],
  exports: [RepasseService],
})
export class RepasseModule {}
