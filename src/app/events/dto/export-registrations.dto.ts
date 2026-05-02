import { IsEnum, IsOptional, IsString } from 'class-validator';

export type ExportFormat = 'txt' | 'excel' | 'pdf';

export const EXPORT_FIELDS = [
  'nome',
  'email',
  'cpf',
  'dataNascimento',
  'telefone',
  'sexo',
  'contatoEmergencia',
  'endereco',
  'ingresso',
  'produtosEscolhidos',
  'perguntasRespostas',
  'dataPagamento',
  'status',
  'formaPagamento',
  'valorPago',
] as const;

export type ExportField = (typeof EXPORT_FIELDS)[number];

export class ExportRegistrationsDto {
  @IsEnum(['txt', 'excel', 'pdf'])
  format: ExportFormat;

  /** Comma-separated list of field IDs. Defaults to all if omitted. */
  @IsOptional()
  @IsString()
  fields?: string;

  /** Text search (name, email, CPF, registration/order ID). */
  @IsOptional()
  @IsString()
  search?: string;

  /** Registration status filter (e.g. CONFIRMED, CANCELLED). Omit or pass "all" for no filter. */
  @IsOptional()
  @IsString()
  status?: string;

  /** Comma-separated ticket IDs. */
  @IsOptional()
  @IsString()
  ticketIds?: string;

  /** ISO date — filter registrations created on or after this date. */
  @IsOptional()
  @IsString()
  startDate?: string;

  /** ISO date — filter registrations created on or before this date. */
  @IsOptional()
  @IsString()
  endDate?: string;
}
