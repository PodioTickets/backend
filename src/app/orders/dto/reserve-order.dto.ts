import { IsArray, IsInt, IsOptional, IsUUID, Min, ValidateNested } from 'class-validator';
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
}
