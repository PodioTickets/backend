import { IsEmail, IsString, IsOptional, MinLength, IsNotEmpty, IsBoolean, IsDateString, IsEnum, Matches, Length, registerDecorator, ValidationOptions, ValidationArguments } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Gender, DocumentType, Language, AccountType } from '@prisma/client';

function isValidCpf(cpf: string): boolean {
  const digits = cpf.replace(/\D/g, '');
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
  const calc = (factor: number) => {
    let sum = 0;
    for (let i = 0; i < factor - 1; i++) sum += parseInt(digits[i]) * (factor - i);
    const remainder = (sum * 10) % 11;
    return remainder >= 10 ? 0 : remainder;
  };
  return calc(10) === parseInt(digits[9]) && calc(11) === parseInt(digits[10]);
}

function IsAdult(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isAdult',
      target: object.constructor,
      propertyName,
      options: { message: 'Usuário deve ter pelo menos 18 anos', ...options },
      validator: {
        validate(value: any) {
          if (!value || typeof value !== 'string') return false;
          const birth = new Date(value);
          if (isNaN(birth.getTime())) return false;
          const today = new Date();
          const age = today.getFullYear() - birth.getFullYear();
          const m = today.getMonth() - birth.getMonth();
          return age > 18 || (age === 18 && (m > 0 || (m === 0 && today.getDate() >= birth.getDate())));
        },
      },
    });
  };
}

function IsValidCpf(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidCpf',
      target: object.constructor,
      propertyName,
      options: { message: 'CPF inválido', ...options },
      validator: {
        validate(value: any) {
          if (!value || typeof value !== 'string') return false;
          return isValidCpf(value);
        },
      },
    });
  };
}

/**
 * Decide se o usuário é brasileiro a partir do campo `country`. Aceita
 * variantes ("BR", "Brasil", "Brazil"). null/undefined → assume BR (default
 * compatível com cadastros antigos).
 */
function isBrazilianCountry(country: unknown): boolean {
  if (typeof country !== 'string' || !country.trim()) return true;
  const c = country.trim().toLowerCase();
  return c === 'br' || c === 'brasil' || c === 'brazil';
}

/**
 * Valida o número de documento conforme nacionalidade:
 *   - Brasileiro (country = BR / Brasil / Brazil ou ausente): exige CPF válido
 *     (11 dígitos + algoritmo de verificação).
 *   - Estrangeiro: aceita qualquer string não-vazia entre 4 e 30 caracteres
 *     (passaporte, identidade nacional, RNE, etc). Não tenta validar formato
 *     pois cada país tem suas próprias regras.
 *
 * Como class-validator não passa o objeto raiz para validadores @IsXxx
 * convencionais, usamos `ValidationArguments.object` para acessar o `country`
 * irmão durante a validação.
 */
function IsValidDocumentNumber(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidDocumentNumber',
      target: object.constructor,
      propertyName,
      options: { ...options },
      validator: {
        validate(value: any, args: ValidationArguments) {
          if (!value || typeof value !== 'string') return false;
          const root = args.object as Record<string, unknown>;
          if (isBrazilianCountry(root.country)) {
            return isValidCpf(value);
          }
          /* Documento estrangeiro: trim + tamanho razoável. */
          const trimmed = value.trim();
          return trimmed.length >= 4 && trimmed.length <= 30;
        },
        defaultMessage(args: ValidationArguments) {
          const root = args.object as Record<string, unknown>;
          if (isBrazilianCountry(root.country)) return 'CPF inválido';
          return 'Documento inválido (mínimo 4 e máximo 30 caracteres)';
        },
      },
    });
  };
}

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

  @ApiProperty({ description: 'Phone number (digits only, 10 or 11)', example: '11999999999' })
  @IsString()
  @Matches(/^\d{10,11}$/, { message: 'Telefone deve conter apenas dígitos (10 ou 11)' })
  phone: string;

  @ApiPropertyOptional({ description: 'Emergency/reserve phone number (digits only, 10 or 11)' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{10,11}$/, { message: 'Telefone de emergência deve conter apenas dígitos (10 ou 11)' })
  reserve_phone?: string;

  @ApiProperty({ description: 'Date of birth (YYYY-MM-DD), user must be at least 18', format: 'date' })
  @IsDateString()
  @IsAdult()
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

  @ApiProperty({
    description:
      'Document number. Para brasileiros (country = BR/Brasil/Brazil ou ausente) deve ser um CPF válido. Para estrangeiros aceita passaporte ou outro documento (4-30 caracteres).',
  })
  @IsString()
  @IsNotEmpty()
  @IsValidDocumentNumber()
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

export class TwoFactorCodeDto {
  @ApiProperty({ description: 'Código numérico de 6 dígitos enviado por e-mail para ativar/desativar o 2FA', example: '482931' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'O código deve conter exatamente 6 dígitos numéricos' })
  code: string;
}

export class VerifyLoginMfaDto {
  @ApiProperty({ description: 'Token MFA temporário retornado quando mfaRequired=true no login', example: 'eyJhbGci...' })
  @IsString()
  @IsNotEmpty()
  mfaToken: string;

  @ApiProperty({ description: 'Código numérico de 6 dígitos enviado por e-mail', example: '482931' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'O código deve conter exatamente 6 dígitos numéricos' })
  code: string;
}
