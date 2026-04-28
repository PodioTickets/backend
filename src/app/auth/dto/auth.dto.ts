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

  @ApiProperty({ description: 'Complete name (first and last)' })
  @IsString()
  @IsNotEmpty()
  complete_name: string;

  @ApiProperty({ description: 'Gender', enum: Gender })
  @IsEnum(Gender)
  gender: Gender;

  @ApiProperty({ description: 'Phone number' })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiPropertyOptional({ description: 'Emergency/reserve phone number' })
  @IsOptional()
  @IsString()
  reserve_phone?: string;

  @ApiProperty({ description: 'Date of birth', format: 'date' })
  @IsDateString()
  dateOfBirth: string;

  @ApiProperty({ description: 'Country' })
  @IsString()
  @IsNotEmpty()
  country: string;

  @ApiPropertyOptional({ description: 'State' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ description: 'City' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiProperty({ description: 'Document type', enum: DocumentType })
  @IsEnum(DocumentType)
  documentType: DocumentType;

  @ApiProperty({ description: 'Document number (CPF or Passport)' })
  @IsString()
  @IsNotEmpty()
  documentNumber: string;

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

export class ChangeEmailDto {
  @ApiProperty({ description: 'New email address' })
  @IsEmail()
  @IsNotEmpty()
  newEmail: string;

  @ApiProperty({ description: 'Current password (required for security confirmation)' })
  @IsString()
  @IsNotEmpty()
  currentPassword: string;
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

export class VerifyEmailChangeDto {
  @ApiProperty({ description: 'Código de verificação enviado ao novo e-mail (6 dígitos)' })
  @IsString()
  @IsNotEmpty()
  code: string;
}
