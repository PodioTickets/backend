import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsEmail,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  Matches,
  MinLength,
} from 'class-validator';

export enum GenderEnum {
  MASCULINO = 'masculino',
  FEMININO = 'feminino',
  OUTRO = 'outro',
  PREFIRO_NAO_DIZER = 'prefiro-nao-dizer',
}

export class CreateLinkedUserDto {
  @ApiProperty({
    description: 'Primeiro nome do usuário',
    example: 'Maria',
  })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({
    description: 'Sobrenome do usuário',
    example: 'Silva',
  })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiProperty({
    description: 'Email do usuário',
    example: 'maria@example.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    description: 'CPF do usuário (apenas números, sem formatação)',
    example: '98765432100',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{11}$/, {
    message: 'CPF deve conter exatamente 11 dígitos numéricos',
  })
  documentNumber: string;

  @ApiProperty({
    description: 'Telefone do usuário (apenas números, sem formatação)',
    example: '11988888888',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(10, {
    message: 'Telefone deve ter no mínimo 10 dígitos',
  })
  @Matches(/^\d+$/, {
    message: 'Telefone deve conter apenas números',
  })
  phone: string;

  @ApiProperty({
    description: 'Data de nascimento no formato ISO 8601 (YYYY-MM-DD)',
    example: '1992-05-20',
  })
  @IsDateString()
  @IsNotEmpty()
  dateOfBirth: string;

  @ApiProperty({
    description: 'Gênero do usuário',
    enum: GenderEnum,
    example: 'feminino',
  })
  @IsEnum(GenderEnum, {
    message: 'Gênero deve ser: masculino, feminino, outro ou prefiro-nao-dizer',
  })
  @IsNotEmpty()
  gender: GenderEnum;
}

