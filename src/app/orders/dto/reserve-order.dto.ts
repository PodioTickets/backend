import { IsArray, IsBoolean, IsInt, IsOptional, IsUUID, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class ReserveTicketItemDto {
  @IsUUID()
  ticketId: string;

  @IsOptional()
  @IsUUID()
  batchId?: string;

  @IsInt()
  @Min(1)
  quantity: number;
}

export class ReserveOrderDto {
  @IsUUID()
  eventId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReserveTicketItemDto)
  tickets: ReserveTicketItemDto[];

  /**
   * Reserva de CORTESIA (organizador "adicionar inscrito"). Quando true, o
   * backend AUTORIZA (admin/`edit_event`) e então libera: janela de inscrição
   * encerrada + lote esgotado + teto do evento. Um público não pode se
   * auto-declarar — a autorização é verificada no serviço.
   */
  @IsOptional()
  @IsBoolean()
  isCourtesy?: boolean;
}
