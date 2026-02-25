import { IsString, IsEmail, IsOptional, IsEnum, IsUrl } from 'class-validator';
import { OrganizationMemberRole } from '@prisma/client';

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

  @IsOptional()
  @IsUrl()
  siteUrl?: string;

  @IsOptional()
  @IsString()
  instagram?: string;

  @IsOptional()
  @IsString()
  description?: string;

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

  // Nome do responsável (owner)
  @IsOptional()
  @IsString()
  ownerName?: string; // Nome do responsável (owner)

  // Informações bancárias
  @IsOptional()
  @IsString()
  pix?: string; // Chave PIX

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
}

export class UpdateMemberRoleDto {
  @IsEnum(OrganizationMemberRole)
  role: OrganizationMemberRole;
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

  @IsOptional()
  @IsUrl()
  siteUrl?: string;

  @IsOptional()
  @IsString()
  instagram?: string;

  @IsOptional()
  @IsString()
  description?: string;

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

  // Nome do responsável (owner)
  @IsOptional()
  @IsString()
  ownerName?: string; // Nome do responsável (owner)

  // Informações bancárias
  @IsOptional()
  @IsString()
  pix?: string; // Chave PIX

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
}

export class UpdateOrganizationLogoDto {
  @IsString()
  logoUrl: string; // URL da foto/logo da organização
}
