import {
  IsString,
  IsEmail,
  IsOptional,
  IsBoolean,
  IsDateString,
  IsEnum,
} from 'class-validator';
import { Gender, DocumentType, Language } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';

export class CreateUserDto {
  @IsEmail()
  @ApiProperty({ description: 'User email' })
  email: string;

  @IsString()
  @ApiProperty({ description: 'User password' })
  password: string;

  @IsString()
  @ApiProperty({ description: 'User first name' })
  firstName: string;

  @IsString()
  @ApiProperty({ description: 'User last name' })
  lastName: string;

  @IsOptional()
  @IsEnum(Gender)
  @ApiProperty({ description: 'User gender', enum: Gender })
  gender?: Gender;

  @IsOptional()
  @IsString()
  @ApiProperty({ description: 'User phone' })
  phone?: string;

  @IsOptional()
  @IsDateString()
  @ApiProperty({ description: 'User date of birth', format: 'date' })
  dateOfBirth?: string;

  @IsOptional()
  @IsString()
  @ApiProperty({ description: 'User country' })
  country?: string;

  @IsOptional()
  @IsString()
  @ApiProperty({ description: 'User state' })
  state?: string;

  @IsOptional()
  @IsString()
  @ApiProperty({ description: 'User city' })
  city?: string;

  @IsOptional()
  @IsEnum(DocumentType)
  @ApiProperty({ description: 'User document type', enum: DocumentType })
  documentType?: DocumentType;

  @IsOptional()
  @IsString()
  @ApiProperty({ description: 'User document number' })
  documentNumber?: string;

  @IsOptional()
  @IsString()
  @ApiProperty({ description: 'User sex' })
  sex?: string;

  @IsBoolean()
  @ApiProperty({ description: 'User accepted terms' })
  acceptedTerms: boolean;

  @IsBoolean()
  @ApiProperty({ description: 'User accepted privacy policy' })
  acceptedPrivacyPolicy: boolean;

  @IsOptional()
  @IsBoolean()
  @ApiProperty({ description: 'User receive calendar events' })
  receiveCalendarEvents?: boolean;

  @IsOptional()
  @IsBoolean()
  @ApiProperty({ description: 'User receive partner promos' })
  receivePartnerPromos?: boolean;

  @IsOptional()
  @IsEnum(Language)
  @ApiProperty({ description: 'User language', enum: Language })
  language?: Language;

  @IsOptional()
  @IsString()
  @ApiProperty({ description: 'User avatar URL' })
  avatarUrl?: string;
}

