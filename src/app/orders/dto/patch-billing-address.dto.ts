import { IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class BillingAddressDto {
  @IsOptional()
  @IsString()
  country?: string;

  @IsString()
  postalCode: string;

  @IsString()
  stateUf: string;

  @IsString()
  street: string;

  @IsString()
  number: string;

  @IsOptional()
  @IsString()
  complement?: string;

  @IsOptional()
  @IsString()
  neighborhood?: string;

  @IsString()
  city: string;
}

export class PatchBillingAddressDto {
  @ValidateNested()
  @Type(() => BillingAddressDto)
  billingAddress: BillingAddressDto;
}
