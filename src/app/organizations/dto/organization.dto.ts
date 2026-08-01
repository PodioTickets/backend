import { Transform, Type } from 'class-transformer';
import {
  IsString,
  IsEmail,
  IsOptional,
  IsEnum,
  IsUrl,
  IsObject,
  IsArray,
  IsBoolean,
  IsUUID,
  IsInt,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { OrganizationMemberRole } from '@prisma/client';

/**
 * Item de chave PIX. Compartilhado entre criação e edição de organização —
 * tanto o admin (POST/PATCH /api/v1/admin/organizations) quanto o próprio organizador
 * usam essa mesma forma.
 */
export class PixKeyItemDto {
  @IsString()
  key: string;

  @IsString()
  keyType: string; // CPF, CNPJ, EMAIL, PHONE, RANDOM

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsString()
  bankName?: string;

  @IsOptional()
  @IsString()
  accountHolderName?: string;

  @IsOptional()
  @IsString()
  accountHolderDocument?: string;
}

export class CreateOrganizationDto {
  // Opção 1: Usar usuário existente (userId)
  @IsOptional()
  @IsString()
  userId?: string; // ID do usuário existente que será o OWNER

  // Opção 2: Criar novo usuário (dados do owner)
  @IsOptional()
  @IsEmail()
  ownerEmail?: string; // Email do owner (para criar novo usuário)

  @IsOptional()
  @IsString()
  ownerPassword?: string; // Senha do owner (para criar novo usuário)

  @IsOptional()
  @IsString()
  ownerFirstName?: string; // Nome do owner (para criar novo usuário)

  @IsOptional()
  @IsString()
  ownerLastName?: string; // Sobrenome do owner (para criar novo usuário)

  @IsOptional()
  @IsString()
  ownerPhone?: string; // Telefone do owner (para criar novo usuário)

  @IsOptional()
  @IsString()
  ownerDocumentNumber?: string; // CPF do owner (para criar novo usuário)

  @IsString()
  name: string; // Razão social

  @IsOptional()
  @IsString()
  tradeName?: string; // Nome fantasia

  @IsOptional()
  @IsString()
  document?: string; // CPF ou CNPJ (apenas números)

  @IsOptional()
  @IsString()
  logoUrl?: string; // Foto/logo da organização

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  whatsapp?: string;

  // Trata "" como ausência: @IsOptional() ignora apenas null/undefined,
  // então convertemos string vazia para undefined antes do @IsUrl rodar.
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsUrl()
  siteUrl?: string;

  @IsOptional()
  @IsString()
  instagram?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEmail()
  fiscalEmail?: string; // E-mail fiscal

  // Endereço
  @IsOptional()
  @IsString()
  zipCode?: string; // CEP

  @IsOptional()
  @IsString()
  street?: string; // Rua

  @IsOptional()
  @IsString()
  number?: string; // Número

  @IsOptional()
  @IsString()
  neighborhood?: string; // Bairro

  @IsOptional()
  @IsString()
  city?: string; // Cidade

  @IsOptional()
  @IsString()
  state?: string; // Estado

  // Responsável (owner)
  @IsOptional()
  @IsString()
  ownerName?: string; // Nome do responsável

  @IsOptional()
  @IsString()
  ownerDocument?: string; // CPF do responsável (apenas números)

  // Informações bancárias
  @IsOptional()
  @IsString()
  bankName?: string; // Nome do banco

  @IsOptional()
  @IsString()
  bankCode?: string; // Código do banco (ex: 001, 237)

  @IsOptional()
  @IsString()
  agency?: string; // Agência

  @IsOptional()
  @IsString()
  account?: string; // Conta

  @IsOptional()
  @IsString()
  accountType?: string; // Tipo de conta: CORRENTE, POUPANCA

  @IsOptional()
  @IsString()
  accountHolderName?: string; // Nome do titular da conta

  @IsOptional()
  @IsString()
  accountHolderDocument?: string; // CPF/CNPJ do titular

  // Chaves PIX iniciais da organização (idêntico ao UPDATE).
  // Se enviado, as chaves são criadas na mesma transação da organização.
  // Se nenhuma vier marcada como `isDefault`, a primeira é promovida automaticamente.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PixKeyItemDto)
  pixKeys?: PixKeyItemDto[];
}

export class AddMemberDto {
  // Se userId for fornecido, usa usuário existente
  // Se não, cria novo usuário com os dados abaixo
  @IsOptional()
  @IsString()
  userId?: string;

  // Dados para criar novo usuário (se userId não fornecido)
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  // Habilitar 2FA ao criar o usuário
  @IsOptional()
  enable2FA?: boolean;

  @IsEnum(OrganizationMemberRole)
  role: OrganizationMemberRole;

  /** Canonical permission keys, e.g. `["dashboard", "edit_event"]`. Omit for server defaults. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  eventIds?: string[];
}

export class PutMemberPermissionsDto {
  /** Replaces stored permissions; values must be canonical keys (`dashboard`, `edit_event`, …). */
  @IsArray()
  @IsString({ each: true })
  permissions: string[];

  @IsOptional()
  @IsString()
  clientPage?: string;
}

export class PutMemberEventsDto {
  @IsArray()
  @IsUUID('4', { each: true })
  eventIds: string[];

  @IsOptional()
  @IsString()
  clientPage?: string;
}

export class PatchMemberSettingsDto {
  @IsOptional()
  @IsEnum(OrganizationMemberRole)
  role?: OrganizationMemberRole;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  eventIds?: string[];

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  clientPage?: string;
}

export class OrganizationAuditLogQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Filtros extras para listagem global de audit logs (admin). */
export class AdminAuditLogQueryDto extends OrganizationAuditLogQueryDto {
  @IsOptional()
  @IsUUID('4')
  organizationId?: string;

  @IsOptional()
  @IsString()
  kind?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description:
      'Filtra por usuário autor (ator): substring em nome, sobrenome ou e-mail (case insensitive). Logs sem ator são excluídos quando informado.',
  })
  userSearch?: string;
}

/** Listagem paginada de organizações (painel admin). */
export class AdminOrganizationsListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @ApiPropertyOptional({ description: 'Página (default 1)', example: 1 })
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({
    description: 'Itens por página (default 20, máx. 100)',
    example: 20,
  })
  limit?: number;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description:
      'Busca em razão social, nome fantasia, e-mail ou documento (substring)',
  })
  q?: string;
}

export class UpdateMemberRoleDto {
  @IsEnum(OrganizationMemberRole)
  role: OrganizationMemberRole;

  @IsOptional()
  @IsString()
  clientPage?: string;
}

/** Dedup de page views: o frontend envia ao montar uma rota (ex.: `dashboard`). */
export class RecordOrganizerPageViewDto {
  @IsString()
  pageKey: string;
}

export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  name?: string; // Razão social

  @IsOptional()
  @IsString()
  tradeName?: string; // Nome fantasia

  @IsOptional()
  @IsString()
  document?: string; // CPF ou CNPJ (apenas números)

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  whatsapp?: string;

  // Trata "" como ausência: @IsOptional() ignora apenas null/undefined,
  // então convertemos string vazia para undefined antes do @IsUrl rodar.
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsUrl()
  siteUrl?: string;

  @IsOptional()
  @IsString()
  instagram?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEmail()
  fiscalEmail?: string; // E-mail fiscal

  // Endereço
  @IsOptional()
  @IsString()
  zipCode?: string; // CEP

  @IsOptional()
  @IsString()
  street?: string; // Rua

  @IsOptional()
  @IsString()
  number?: string; // Número

  @IsOptional()
  @IsString()
  neighborhood?: string; // Bairro

  @IsOptional()
  @IsString()
  city?: string; // Cidade

  @IsOptional()
  @IsString()
  state?: string; // Estado

  // Responsável (owner)
  @IsOptional()
  @IsString()
  ownerName?: string; // Nome do responsável

  @IsOptional()
  @IsString()
  ownerDocument?: string; // CPF do responsável (apenas números)

  // Informações bancárias
  @IsOptional()
  @IsString()
  bankName?: string; // Nome do banco

  @IsOptional()
  @IsString()
  bankCode?: string; // Código do banco (ex: 001, 237)

  @IsOptional()
  @IsString()
  agency?: string; // Agência

  @IsOptional()
  @IsString()
  account?: string; // Conta

  @IsOptional()
  @IsString()
  accountType?: string; // Tipo de conta: CORRENTE, POUPANCA

  @IsOptional()
  @IsString()
  accountHolderName?: string; // Nome do titular da conta

  @IsOptional()
  @IsString()
  accountHolderDocument?: string; // CPF/CNPJ do titular

  // Chaves PIX — substituição completa quando enviadas (mesma semântica do admin).
  // Permite o próprio organizador gerir suas chaves pela tela de Configurações.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PixKeyItemDto)
  pixKeys?: PixKeyItemDto[];
}

export class UpdateOrganizationLogoDto {
  @IsString()
  logoUrl: string; // URL da foto/logo da organização
}
