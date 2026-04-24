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

const emptyToUndefined = ({ value }: { value: any }) =>
  value === '' || value === null ? undefined : value;

export class ParticipantDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  cpf?: string;

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
