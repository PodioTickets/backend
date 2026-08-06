import { ApiPropertyOptional } from '@nestjs/swagger';
import { DocumentType } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * PATCH parcial dos dados do participante de uma inscrição (uso do ORGANIZADOR
 * a partir do painel de inscrições). Todos os campos são opcionais — apenas os
 * enviados são atualizados. O documento é normalizado no service via
 * `resolveDocument`/`cleanDocumentNumber` (regra única do projeto — nunca
 * `.replace(/\D/g,'')` cru, que quebra passaporte estrangeiro).
 *
 * A gravação acontece no `receiptSnapshot` (recibo imutável, fonte da tela/PDF)
 * E nas colunas-espelho da `Registration` (que alimentam buscas, `/me/:id` e as
 * views de pedido). O `User` vivo NÃO é tocado — o participante pode ser um
 * convidado sem conta, ou pessoa distinta do comprador.
 */
export class UpdateRegistrationParticipantDto {
  @ApiPropertyOptional({ description: 'Nome completo do participante' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ description: 'E-mail do participante' })
  @IsOptional()
  @IsEmail({}, { message: 'E-mail inválido' })
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ enum: DocumentType, description: 'Tipo do documento' })
  @IsOptional()
  @IsEnum(DocumentType)
  documentType?: DocumentType;

  @ApiPropertyOptional({ description: 'Número do documento (com ou sem máscara)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  documentNumber?: string;

  @ApiPropertyOptional({ description: 'Telefone do participante' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ description: 'Data de nascimento (YYYY-MM-DD)' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  birthDate?: string;

  @ApiPropertyOptional({ description: 'Sexo (masculino | feminino | outro)' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  gender?: string;

  @ApiPropertyOptional({ description: 'País / nacionalidade do participante' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @ApiPropertyOptional({ description: 'Nome do contato de emergência' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  emergencyContactName?: string;

  @ApiPropertyOptional({ description: 'Telefone do contato de emergência' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  emergencyContactPhone?: string;
}
