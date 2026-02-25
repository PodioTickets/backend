import { Module } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { MFAService } from '../../common/services/mfa.service';
import { CommonModule } from '../../common/common.module';

@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService, MFAService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
