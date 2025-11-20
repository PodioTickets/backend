import { ApiProperty } from '@nestjs/swagger';

export class UploadDto {
  @ApiProperty({ type: 'string', format: 'binary' })
  file: any;
}
