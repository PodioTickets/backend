import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { CreateUserDto } from './create-user.dto';
import { IsOptional, IsString, IsEnum } from 'class-validator';
import { Transform } from 'class-transformer';
import { Gender } from '@prisma/client';

export class UpdateUserDto extends PartialType(CreateUserDto) {
  @ApiPropertyOptional({
    description: 'Endereço da carteira Solana (44 caracteres base58)',
    example: '7xKXtg2CW99iVRBZ1W2Gz9n7dHf8GzQGjzJ8LwWJGzQ',
    required: false,
  })
  @IsOptional()
  @IsString()
  walletAddress?: string;

  @ApiPropertyOptional({
    description: 'URL do avatar do usuário',
    example: '/uploads/images/1234567890-123456789.webp',
    required: false,
  })
  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @ApiPropertyOptional({
    description: 'Telefone de reserva/emergência',
    example: '11999999999',
    required: false,
  })
  @IsOptional()
  @IsString()
  reservePhone?: string;

  @ApiPropertyOptional({
    description: 'Telefone de emergência (alias para reservePhone)',
    example: '11999999999',
    required: false,
  })
  @IsOptional()
  @IsString()
  emergencyPhone?: string;

  @ApiPropertyOptional({
    description: 'Gênero do usuário. Aceita valores em português (masculino, feminino, outro, prefiro-nao-dizer) ou em inglês (MALE, FEMALE, OTHER, PREFER_NOT_TO_SAY)',
    enum: Gender,
    example: 'MALE',
    required: false,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return value;
    const genderMap: Record<string, Gender> = {
      'masculino': Gender.MALE,
      'feminino': Gender.FEMALE,
      'outro': Gender.OTHER,
      'prefiro-nao-dizer': Gender.PREFER_NOT_TO_SAY,
      'prefiro não dizer': Gender.PREFER_NOT_TO_SAY,
    };
    const normalizedGender = String(value).toLowerCase().trim();
    return genderMap[normalizedGender] || value;
  })
  @IsEnum(Gender)
  gender?: Gender;
}
