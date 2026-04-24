import { IsEmail, IsString, IsOptional, MinLength, IsNotEmpty, IsBoolean, IsDateString, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Gender, DocumentType, Language, AccountType } from '@prisma/client';

export class EmailLoginDto {
  @ApiProperty({ 
    description: 'User email or CPF',
    example: 'user@example.com' 
  })
  @IsString()
  @IsNotEmpty()
  emailOrCpf: string;

  @ApiProperty({ description: 'User password', minLength: 8 })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password: string;

  @ApiPropertyOptional({ 
    description: 'Account type: USER (participant) or ORGANIZER',
    enum: AccountType,
    default: AccountType.USER
  })
  @IsOptional()
  @IsEnum(AccountType)
  accountType?: AccountType;
}

export class EmailRegisterDto {
  @ApiProperty({ description: 'User email' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'User password', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiPropertyOptional({ description: 'Complete name' })
  @IsOptional()
  @IsString()
  complete_name?: string;

  @ApiPropertyOptional({ description: 'Gender', enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional({ description: 'Phone number' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ description: 'Phone number' })
  @IsOptional()
  @IsString()
  reserve_phone?: string;

  @ApiPropertyOptional({ description: 'Date of birth', format: 'date' })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional({ description: 'Country' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ description: 'State' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ description: 'City' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ description: 'Document type', enum: DocumentType })
  @IsOptional()
  @IsEnum(DocumentType)
  documentType?: DocumentType;

  @ApiPropertyOptional({ description: 'Document number (CPF or Passport)' })
  @IsOptional()
  @IsString()
  documentNumber?: string;

  @ApiPropertyOptional({ description: 'Sex' })
  @IsOptional()
  @IsString()
  sex?: string;

  @ApiProperty({ description: 'Accept terms of purchase' })
  @IsBoolean()
  acceptedTerms: boolean;

  @ApiProperty({ description: 'Accept privacy policy' })
  @IsBoolean()
  acceptedPrivacyPolicy: boolean;

  @ApiPropertyOptional({ description: 'Receive calendar events from PodioGo' })
  @IsOptional()
  @IsBoolean()
  receiveCalendarEvents?: boolean;

  @ApiPropertyOptional({ description: 'Receive promotions from partners' })
  @IsOptional()
  @IsBoolean()
  receivePartnerPromos?: boolean;

  @ApiPropertyOptional({ description: 'Language preference', enum: Language, default: 'PT' })
  @IsOptional()
  @IsEnum(Language)
  language?: Language;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh token' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ description: 'User email' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ 
    description: 'Account type: USER (participant) or ORGANIZER',
    enum: AccountType,
    default: AccountType.USER
  })
  @IsOptional()
  @IsEnum(AccountType)
  accountType?: AccountType;
}

export class ResetPasswordDto {
  @ApiProperty({
    description:
      'Token opaco do link (?token=...) ou JWT retornado por verify-reset-code (legado)',
  })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ description: 'New password', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;
}

export class ChangePasswordDto {
  @ApiPropertyOptional({
    description: 'Current password. Obrigatório apenas se o usuário já tiver senha (ex.: conta email/senha). Omitir para usuários que só têm login social.',
  })
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @ApiProperty({ description: 'New password', minLength: 8 })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  newPassword: string;
}

export class VerifyResetCodeDto {
  @ApiProperty({ description: 'User email' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'Reset code (6 digits)' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiPropertyOptional({ 
    description: 'Account type: USER (participant) or ORGANIZER',
    enum: AccountType,
    default: AccountType.USER
  })
  @IsOptional()
  @IsEnum(AccountType)
  accountType?: AccountType;
}

export class ResendResetCodeDto {
  @ApiProperty({ description: 'User email' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ 
    description: 'Account type: USER (participant) or ORGANIZER',
    enum: AccountType,
    default: AccountType.USER
  })
  @IsOptional()
  @IsEnum(AccountType)
  accountType?: AccountType;
}

export class VerifyEmailDto {
  @ApiProperty({ description: 'Verification token' })
  @IsString()
  @IsNotEmpty()
  token: string;
}
