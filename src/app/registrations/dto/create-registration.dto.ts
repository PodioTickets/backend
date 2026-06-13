import { IsString, IsOptional, IsBoolean, IsArray, IsNumber, Min, ValidateNested, MaxLength } from 'class-validator';
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
  @MaxLength(5000)
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

  @IsOptional()
  @IsString()
  couponCode?: string; // Código do cupom de desconto

  @IsOptional()
  @IsString()
  voucherCode?: string; // Código do voucher
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

