import { IsString, IsOptional, IsBoolean, IsArray, ValidateNested, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

export class KitItemSizeDto {
  @IsString()
  size: string;

  @IsNumber()
  stock: number;
}

export class CreateKitItemDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KitItemSizeDto)
  sizes: KitItemSizeDto[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateKitDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateKitItemDto)
  items?: CreateKitItemDto[];
}

export class UpdateKitDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateKitItemDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KitItemSizeDto)
  sizes?: KitItemSizeDto[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

