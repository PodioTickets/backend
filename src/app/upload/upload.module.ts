import { Module } from '@nestjs/common';
import { UploadService } from './upload.service';
import { UploadController } from './upload.controller';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ConfigModule } from '@nestjs/config';
import { SecurityMonitoringService } from 'src/common/services/security-monitoring.service';
import { SecurityAlertsService } from 'src/common/services/security-alerts.service';

@Module({
  imports: [
    MulterModule.register({
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (req, file, cb) => {
        if (!file.mimetype.match(/\/(jpg|jpeg|png|gif|webp)$/)) {
          cb(new Error('Only image files are allowed!'), false);
        }
        cb(null, true);
      },
    }),
    ConfigModule,
  ],
  controllers: [UploadController],
  providers: [UploadService, SecurityMonitoringService, SecurityAlertsService],
})
export class UploadModule {}
