import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

/** Uma resposta a atualizar — casada com a pergunta por `questionId`. */
export class RegistrationAnswerItemDto {
  @ApiProperty({ description: 'UUID da pergunta' })
  @IsUUID()
  questionId: string;

  @ApiProperty({ description: 'Resposta (multi-escolha vai serializada como JSON string)' })
  @IsString()
  answer: string;
}

/**
 * Edição em lote das respostas das perguntas do organizador (uso do ORGANIZADOR
 * no painel de inscrições). Atualiza `QuestionAnswer` (relacional) + a entrada
 * correspondente em `receiptSnapshot.questionAnswers`.
 */
export class UpdateRegistrationAnswersDto {
  @ApiProperty({ type: [RegistrationAnswerItemDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => RegistrationAnswerItemDto)
  answers: RegistrationAnswerItemDto[];
}
