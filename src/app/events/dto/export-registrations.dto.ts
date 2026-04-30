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
}
