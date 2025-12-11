import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { CreateUserDto } from './create-user.dto';
import { IsOptional } from 'class-validator';

export class UpdateUserDto extends PartialType(CreateUserDto) {
  @ApiPropertyOptional({
    description: 'Endereço da carteira Solana (44 caracteres base58)',
    example: '7xKXtg2CW99iVRBZ1W2Gz9n7dHf8GzQGjzJ8LwWJGzQ',
    required: false,
  })
  @IsOptional()
  walletAddress?: string;

  @ApiPropertyOptional({
    description: 'URL do avatar do usuário',
    example: '/uploads/images/1234567890-123456789.webp',
    required: false,
  })
  @IsOptional()
  avatarUrl?: string;
}
