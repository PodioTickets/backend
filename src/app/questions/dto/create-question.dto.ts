import { IsString, IsOptional, IsBoolean, IsArray, IsInt, Min, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Tipos que o checkout sabe desenhar (`InformationStep.renderQuestionField`). Outro tipo
 * virava pergunta INVISÍVEL — e, se obrigatória, travava a inscrição sem dizer o porquê.
 */
export const QUESTION_TYPES = ['text', 'select', 'multiple_choice', 'true_false', 'number'] as const;

export class CreateQuestionDto {
  @IsString()
  question: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(QUESTION_TYPES)
  type?: string;

  @IsOptional()
  @IsArray()
  options?: string[];

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  order?: number;

  @IsOptional()
  appliesTo?: string | string[];
}

export class UpdateQuestionDto {
  @IsOptional()
  @IsString()
  question?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(QUESTION_TYPES)
  type?: string;

  @IsOptional()
  @IsArray()
  options?: string[];

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  order?: number;

  @IsOptional()
  appliesTo?: string | string[];
}

