import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ReserveTicketItemDto } from './reserve-order.dto';
import { ParticipantDto } from './patch-participants.dto';
import { OrderProductItemDto } from './patch-products.dto';

/**
 * Inscrição de CORTESIA criada pelo organizador na tela de inscrições — replica
 * o checkout (ingressos → participantes → produtos) SEM preço e SEM pagamento.
 * O backend reserva o estoque, materializa a inscrição e finaliza o pedido como
 * R$0 (PAID/cortesia). Um único request (o front coleta tudo localmente).
 */
export class CreateCourtesyOrderDto {
  @IsUUID()
  eventId: string;

  /** Ingressos + quantidades (mesma forma da reserva do checkout). */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReserveTicketItemDto)
  tickets: ReserveTicketItemDto[];

  /** Um participante por UNIDADE de ingresso reservada (posicional). */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ParticipantDto)
  participants: ParticipantDto[];

  /** Produtos/variações de kit por participante (opcional). */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderProductItemDto)
  products?: OrderProductItemDto[];
}
