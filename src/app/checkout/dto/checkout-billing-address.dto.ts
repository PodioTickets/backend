import {
  IsString,
  IsNotEmpty,
  IsOptional,
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export function isBrazilBillingCountry(country: string | undefined): boolean {
  return (country || '').trim().toLowerCase() === 'brasil';
}

/** Valor persistido: BR só dígitos; exterior trim + espaços colapsados. */
export function normalizeBillingPostalCodeForStorage(
  country: string,
  postalCode: string,
): string {
  if (isBrazilBillingCountry(country)) {
    return postalCode.replace(/\D/g, '').slice(0, 8);
  }
  return postalCode.trim().replace(/\s+/g, ' ');
}

/** CEP: 8 dígitos para Brasil; exterior: texto não vazio após trim/espaços colapsados. */
export function IsBillingPostalCode(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isBillingPostalCode',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const o = args.object as CheckoutBillingAddressDto;
          const raw =
            typeof value === 'string'
              ? value.trim().replace(/\s+/g, ' ')
              : '';
          if (!raw) return false;
          if (isBrazilBillingCountry(o.country)) {
            const digits = raw.replace(/\D/g, '');
            return digits.length === 8 && /^\d{8}$/.test(digits);
          }
          return true;
        },
        defaultMessage(args: ValidationArguments) {
          const o = args.object as CheckoutBillingAddressDto;
          if (isBrazilBillingCountry(o.country)) {
            return 'postalCode must be exactly 8 digits for Brasil (no hyphen)';
          }
          return 'postalCode is required';
        },
      },
    });
  };
}

export class CheckoutBillingAddressDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'billingAddress.country is required' })
  @ApiProperty({ example: 'Brasil', description: 'Nome do país (ex.: Brasil)' })
  country: string;

  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    return value.trim().replace(/\s+/g, ' ');
  })
  @IsString()
  @IsNotEmpty({ message: 'billingAddress.postalCode is required' })
  @IsBillingPostalCode()
  @ApiProperty({
    example: '01310100',
    description: 'Brasil: 8 dígitos. Exterior: código postal (texto).',
  })
  postalCode: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === '' || value === null || value === undefined) return undefined;
    return typeof value === 'string' ? value.trim().toUpperCase() : value;
  })
  @IsString()
  @ApiPropertyOptional({ example: 'SP', description: 'UF em maiúsculas (recomendado)' })
  stateUf?: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'billingAddress.street is required' })
  @ApiProperty({ example: 'Avenida Paulista' })
  street: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'billingAddress.number is required' })
  @ApiProperty({ example: '1000' })
  number: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === '' || value === null || value === undefined) return undefined;
    return typeof value === 'string' ? value.trim() : value;
  })
  @IsString()
  @ApiPropertyOptional({ example: 'Sala 12' })
  complement?: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'billingAddress.neighborhood is required' })
  @ApiProperty({ example: 'Bela Vista' })
  neighborhood: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'billingAddress.city is required' })
  @ApiProperty({ example: 'São Paulo' })
  city: string;
}
