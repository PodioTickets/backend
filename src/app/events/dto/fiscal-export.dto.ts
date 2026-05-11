import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

/** Janela temporal baseada em `Payment.paymentDate` (proxy de `paidAt`). */
export enum FiscalPeriod {
  LAST_7D = '7d',
  LAST_15D = '15d',
  LAST_30D = '30d',
  LAST_60D = '60d',
  ALL = 'all',
}

/** Faixa de `Order.finalAmount` em centavos. */
export enum FiscalValueRange {
  ALL = 'all',
  LT_100 = 'lt100',
  RANGE_100_500 = '100to500',
  RANGE_500_1000 = '500to1000',
  GT_1000 = 'gt1000',
}

export enum FiscalExportFormat {
  TXT = 'txt',
  XLSX = 'xlsx',
  PDF = 'pdf',
}

/**
 * Campos exportáveis. Whitelist canônica — a ordem aqui é a ordem das colunas
 * no arquivo gerado, independentemente da ordem em que o front envia `fields`.
 * NUNCA reflitir input do usuário em SQL — sempre validar contra esta lista.
 */
export const FISCAL_EXPORT_FIELDS = [
  'name',
  'email',
  'cpf',
  'birthDate',
  'phone',
  'gender',
  'address',
  'ticket',
  'products',
  'paymentDate',
  'paymentMethod',
  'amountPaid',
  'fee',
  'netAmount',
  'status',
] as const;

export type FiscalExportField = (typeof FISCAL_EXPORT_FIELDS)[number];

export const FISCAL_EXPORT_FIELD_LABELS: Record<FiscalExportField, string> = {
  name: 'Nome',
  email: 'E-mail',
  cpf: 'CPF',
  birthDate: 'Data de nascimento',
  phone: 'Telefone',
  gender: 'Sexo',
  address: 'Endereço',
  ticket: 'Ingresso',
  products: 'Produtos escolhidos',
  paymentDate: 'Data de pagamento',
  paymentMethod: 'Forma de pagamento',
  amountPaid: 'Valor pago',
  fee: 'Taxa',
  netAmount: 'Valor líquido',
  status: 'Status do pedido',
};

/**
 * Parseia uma lista CSV de strings vinda da query (`a,b,c`) em `string[]`.
 * Centralizado para garantir trim + filtro de vazios em todos os params do tipo.
 */
const parseCsv = ({ value }: { value: unknown }): string[] | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) {
    return value.flatMap((v) =>
      typeof v === 'string' ? v.split(',') : [],
    ).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
};

export class FiscalOrdersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsEnum(FiscalPeriod)
  period?: FiscalPeriod;

  @IsOptional()
  @IsEnum(FiscalValueRange)
  valueRange?: FiscalValueRange;
}

export class FiscalExportQueryDto extends FiscalOrdersQueryDto {
  @IsOptional()
  @IsEnum(FiscalExportFormat)
  format?: FiscalExportFormat;

  /**
   * CSV de UUIDs. Quando presente, ignora `search`/`period`/`valueRange`.
   * Limite de 1000 IDs para evitar URLs gigantescas e contenção no DB.
   */
  @IsOptional()
  @Transform(parseCsv)
  @IsArray()
  @IsUUID('all', { each: true })
  orderIds?: string[];

  /**
   * CSV de campos. Validados em runtime contra `FISCAL_EXPORT_FIELDS` (whitelist).
   * Campos desconhecidos são silenciosamente ignorados.
   */
  @IsOptional()
  @Transform(parseCsv)
  @IsArray()
  @IsString({ each: true })
  fields?: string[];
}
