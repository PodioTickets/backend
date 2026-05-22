import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { DocumentType } from '@prisma/client';

export class QuestionAnswerDto {
  @IsUUID()
  questionId: string;

  @IsString()
  answer: string;
}

const emptyToUndefined = ({ value }: { value: any }) =>
  value === '' || value === null ? undefined : value;

export class ParticipantDto {
  @IsOptional()
  @IsString()
  name?: string;

  /**
   * Alias retrocompatível. Aceita o formato antigo (CPF cru ou formatado).
   * Clientes novos devem usar `documentNumber` + `documentType`. O service
   * preenche o documento final via `resolveDocument()` priorizando os
   * campos novos quando ambos vierem.
   */
  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(30)
  cpf?: string;

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsEnum(DocumentType)
  documentType?: DocumentType;

  /**
   * Documento internacionalizado. Charset restrito a alfanumérico + pontos,
   * hífens e espaços — bloqueia injeção de caracteres estranhos (<, ', ;).
   * Length cap em 30 chars (acomoda CPF formatado e passaportes mais longos).
   */
  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(30)
  @Matches(/^[A-Za-z0-9.\-\s]+$/, { message: 'documentNumber inválido' })
  documentNumber?: string;

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsEmail()
  email?: string;

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  birthDate?: string;

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  phone?: string;

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  gender?: string;

  @IsOptional()
  @IsBoolean()
  hasEmergencyContact?: boolean;

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  emergencyContactName?: string;

  @Transform(emptyToUndefined)
  @IsOptional()
  @IsString()
  emergencyPhone?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuestionAnswerDto)
  questionAnswers?: QuestionAnswerDto[];
}

export class PatchParticipantsDto {
  @Transform(({ value }) =>
    Array.isArray(value) ? value.filter((p: any) => p != null) : value,
  )
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ParticipantDto)
  participants: ParticipantDto[];
}
