import {
  IsEmail,
  IsString,
  IsOptional,
  MinLength,
  IsNotEmpty,
  IsEnum,
  Matches,
  ValidateIf,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  isValidCpf,
  isValidCnpj,
} from '../../../common/utils/document-validation.util';

/** Tipo de cadastro do organizador (define os campos exigidos). */
export enum SignupPersonType {
  PF = 'PF',
  PJ = 'PJ',
}

/** Decorator: CPF válido (algoritmo Receita), aceita máscara. */
function IsValidCpf(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidCpf',
      target: object.constructor,
      propertyName,
      options: { message: 'CPF inválido', ...options },
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && isValidCpf(value),
      },
    });
  };
}

/** Decorator: CNPJ válido (algoritmo Receita), aceita máscara. */
function IsValidCnpj(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidCnpj',
      target: object.constructor,
      propertyName,
      options: { message: 'CNPJ inválido', ...options },
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && isValidCnpj(value),
      },
    });
  };
}

/**
 * Payload do auto-cadastro público de organizador
 * (`POST /api/v1/auth/register/organizer`). Cria conta ORGANIZER + Organization
 * ativa + membro OWNER num único request.
 *
 * Campos por `personType`:
 *   - PJ: `document` (CNPJ) + `legalName` (razão social) obrigatórios.
 *   - PF: sem CNPJ/razão social — o documento da org deriva do `ownerDocument`
 *     (CPF do responsável) e o nome da org, do `tradeName`.
 *
 * ValidationPipe global roda com `whitelist + forbidNonWhitelisted`, então
 * TODO campo enviado precisa estar declarado aqui (inclusive `turnstileToken`,
 * lido pelo TurnstileGuard direto do body).
 */
export class OrganizerSignupDto {
  // ─── Acesso ────────────────────────────────────────────────────────────────
  @ApiProperty({ example: 'Maria Silva' })
  @IsString()
  @IsNotEmpty({ message: 'Nome completo é obrigatório' })
  completeName: string;

  @ApiProperty({ example: 'organizador@exemplo.com' })
  @IsEmail({}, { message: 'E-mail inválido' })
  email: string;

  @ApiProperty({ example: 'SenhaF0rte' })
  @IsString()
  @MinLength(8, { message: 'Senha deve ter pelo menos 8 caracteres' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message:
      'Senha deve conter pelo menos uma letra maiúscula, uma minúscula e um número',
  })
  password: string;

  // ─── Tipo ────────────────────────────────────────────────────────────────
  @ApiProperty({ enum: SignupPersonType })
  @IsEnum(SignupPersonType, { message: 'Tipo de cadastro inválido' })
  personType: SignupPersonType;

  // ─── Dados da organização (PJ only) ────────────────────────────────────────
  @ApiPropertyOptional({ description: 'CNPJ (obrigatório para PJ)' })
  @ValidateIf((o: OrganizerSignupDto) => o.personType === SignupPersonType.PJ)
  @IsString()
  @IsValidCnpj()
  document?: string;

  @ApiPropertyOptional({ description: 'Razão social (obrigatório para PJ)' })
  @ValidateIf((o: OrganizerSignupDto) => o.personType === SignupPersonType.PJ)
  @IsString()
  @IsNotEmpty({ message: 'Razão social é obrigatória' })
  legalName?: string;

  // ─── Dados da organização (PF + PJ) ────────────────────────────────────────
  @ApiProperty({ example: 'Meu Evento' })
  @IsString()
  @IsNotEmpty({ message: 'Nome fantasia é obrigatório' })
  tradeName: string;

  @ApiProperty({ example: 'João Responsável' })
  @IsString()
  @IsNotEmpty({ message: 'Nome do responsável é obrigatório' })
  ownerName: string;

  @ApiProperty({ description: 'CPF do responsável', example: '000.000.000-00' })
  @IsString()
  @IsValidCpf()
  ownerDocument: string;

  // ─── Endereço ────────────────────────────────────────────────────────────
  @ApiProperty({ example: '00000-000' })
  @IsString()
  @IsNotEmpty({ message: 'CEP é obrigatório' })
  zipCode: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Rua é obrigatória' })
  street: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  number?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Bairro é obrigatório' })
  neighborhood: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Cidade é obrigatória' })
  city: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Estado é obrigatório' })
  state: string;

  // ─── Contatos ──────────────────────────────────────────────────────────────
  @ApiProperty({ example: 'contato@meuevento.com.br' })
  @IsEmail({}, { message: 'E-mail de contato inválido' })
  orgEmail: string;

  @ApiProperty({ example: '(42) 99999-0000' })
  @IsString()
  @IsNotEmpty({ message: 'WhatsApp é obrigatório' })
  whatsapp: string;

  @ApiPropertyOptional({ example: '(42) 3222-0000' })
  @IsOptional()
  @IsString()
  phone?: string;

  // ─── Anti-abuso ─────────────────────────────────────────────────────────────
  @ApiPropertyOptional({ description: 'Token do Cloudflare Turnstile' })
  @IsOptional()
  @IsString()
  turnstileToken?: string;
}
