import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsString,
  IsEmail,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { DocumentType } from '@prisma/client';

// Valores CANÔNICOS de gênero do projeto — mesmos enviados pelo front e aceitos pelos
// demais DTOs (create-user/auth usam o enum Prisma Gender MALE/FEMALE; OTHER e
// PREFER_NOT_TO_SAY existem no domínio e são mapeados por UserService.mapGenderFromEnum).
// LinkedUser.gender é String?, então persiste o valor mapeado p/ pt-BR (ver service).
export enum GenderEnum {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER',
  PREFER_NOT_TO_SAY = 'PREFER_NOT_TO_SAY',
}

const emptyToUndefined = ({ value }: { value: any }) =>
  value === '' || value === null ? undefined : value;

export class CreateLinkedUserDto {
  @ApiProperty({
    description: 'Primeiro nome do usuário',
    example: 'Maria',
  })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({
    description: 'Sobrenome do usuário',
    example: 'Silva',
  })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiPropertyOptional({
    description: 'Email do usuário',
    example: 'maria@example.com',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    description: 'Nacionalidade do perfil vinculado (nome do país). Persistida no LinkedUser — não herda mais do usuário principal.',
    example: 'Argentina',
  })
  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(60)
  country?: string;

  @ApiPropertyOptional({
    description: 'Tipo do documento. Default CPF para retrocompatibilidade.',
    enum: DocumentType,
    example: 'CPF',
  })
  @Transform(emptyToUndefined)
  @IsOptional()
  @IsEnum(DocumentType)
  documentType?: DocumentType;

  /**
   * Documento do usuário vinculado. Validação real depende do `documentType`:
   *   - CPF (default histórico): exige 11 dígitos após strip de formatação.
   *   - PASSPORT: aceita alfanumérico 4–30 chars (mantém letras essenciais).
   *
   * A regra estrita por tipo é aplicada no service via `resolveDocument()`,
   * pois o DTO precisa aceitar os dois formatos simultaneamente durante a
   * fase de transição. O regex aqui só barra caracteres claramente
   * inválidos (injection chars).
   */
  @ApiProperty({
    description:
      'Documento do usuário. CPF (11 dígitos) ou passaporte (alfanumérico 4-30 chars).',
    example: '98765432100',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  @Matches(/^[A-Za-z0-9.\-\s]+$/, {
    message: 'Documento contém caracteres inválidos',
  })
  documentNumber: string;

  @ApiProperty({
    description: 'Telefone do usuário (apenas números, sem formatação)',
    example: '11988888888',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(10, {
    message: 'Telefone deve ter no mínimo 10 dígitos',
  })
  @Matches(/^\d+$/, {
    message: 'Telefone deve conter apenas números',
  })
  phone: string;

  @ApiProperty({
    description: 'Data de nascimento no formato ISO 8601 (YYYY-MM-DD)',
    example: '1992-05-20',
  })
  @IsDateString()
  @IsNotEmpty()
  dateOfBirth: string;

  @ApiProperty({
    description: 'Gênero do usuário',
    enum: GenderEnum,
    example: 'feminino',
  })
  @IsEnum(GenderEnum, {
    message: 'Gênero deve ser: MALE, FEMALE, OTHER ou PREFER_NOT_TO_SAY',
  })
  @IsNotEmpty()
  gender: GenderEnum;
}

