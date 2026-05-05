import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { OrganizerMemberAccessService } from './organizer-member-access.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { MFAService } from '../../common/services/mfa.service';
import { CommonModule } from '../../common/common.module';
import { EmailService } from '../../common/services/email.service';

@Module({
  imports: [PrismaModule, CommonModule, ConfigModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService, OrganizerMemberAccessService, MFAService, EmailService],
  exports: [OrganizationsService, OrganizerMemberAccessService],
})
export class OrganizationsModule {}
