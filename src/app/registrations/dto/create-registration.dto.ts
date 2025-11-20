import { IsString, IsOptional, IsBoolean, IsArray, IsNumber, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class SelectedModalityDto {
  @IsString()
  modalityId: string;
}

export class SelectedKitItemDto {
  @IsString()
  kitItemId: string;

  @IsString()
  size: string;

  @IsNumber()
  @Min(1)
  @Type(() => Number)
  quantity: number;
}

export class QuestionAnswerDto {
  @IsString()
  questionId: string;

  @IsString()
  answer: string;
}

export class CreateRegistrationDto {
  @IsString()
  eventId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SelectedModalityDto)
  modalities: SelectedModalityDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SelectedKitItemDto)
  kitItems?: SelectedKitItemDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuestionAnswerDto)
  questionAnswers?: QuestionAnswerDto[];

  @IsBoolean()
  termsAccepted: boolean;

  @IsBoolean()
  rulesAccepted: boolean;

  @IsOptional()
  @IsString()
  invitedUserId?: string; // Para convidar outro usuário
}

export class CreateInvitedUserDto {
  @IsString()
  email: string;

  @IsString()
  firstName: string;

  @IsString()
  lastName: string;

  @IsString()
  documentNumber: string;
}

export class CreateRegistrationWithInvitedUserDto extends CreateRegistrationDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateInvitedUserDto)
  invitedUser?: CreateInvitedUserDto;
}

