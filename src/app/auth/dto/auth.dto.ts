import { IsEmail, IsString, IsOptional, MinLength, IsNotEmpty, IsBoolean, IsDateString, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Gender, DocumentType, Language } from '@prisma/client';

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
}

export class EmailRegisterDto {
  @ApiProperty({ description: 'User email' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'User password', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiProperty({ description: 'Complete name' })
  @IsString()
  @IsNotEmpty()
  complete_name: string;

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
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Reset token' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ description: 'New password', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;
}

export class VerifyEmailDto {
  @ApiProperty({ description: 'Verification token' })
  @IsString()
  @IsNotEmpty()
  token: string;
}
