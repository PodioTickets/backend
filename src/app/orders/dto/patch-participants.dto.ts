import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class QuestionAnswerDto {
  @IsUUID()
  questionId: string;

  @IsString()
  answer: string;
}

export class ParticipantDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  cpf?: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  birthDate?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  gender?: string;

  @IsOptional()
  @IsBoolean()
  hasEmergencyContact?: boolean;

  @IsOptional()
  @IsString()
  emergencyContactName?: string;

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
    Array.isArray(value)
      ? value.filter((p: any) => p && (p.name || p.email))
      : value,
  )
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ParticipantDto)
  participants: ParticipantDto[];
}
