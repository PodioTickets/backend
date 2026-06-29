import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Cancelamento de pedido GRATUITO (sem estorno). Diferente do `RefundOrderDto`,
 * não há `force` — não existe valor pago nem impacto de saldo a sobrescrever.
 */
export class CancelOrderDto {
  @ApiProperty({
    description: 'Motivo do cancelamento (registrado em audit log e na metadata do pagamento)',
    example: 'Cancelamento solicitado pelo participante',
    minLength: 3,
    maxLength: 500,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
