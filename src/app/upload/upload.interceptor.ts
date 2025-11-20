import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { UploadService } from './upload.service';
import { unlink } from 'fs/promises';

@Injectable()
export class ImageCompressionInterceptor implements NestInterceptor {
  constructor(private readonly uploadService: UploadService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const req = context.switchToHttp().getRequest();
    if (req.file) {
      try {
        const buffer = await this.uploadService.compressImage(req.file.path);
        req.file.buffer = buffer;
        unlink(req.file.path);
      } catch (error) {
        console.error('Error in interceptor:', error);
      }
    }
    return next.handle();
  }
}
