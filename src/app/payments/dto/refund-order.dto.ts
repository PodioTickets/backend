import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RefundOrderDto {
  @ApiProperty({
    description: 'Motivo do estorno (registrado em audit log e na metadata do pagamento)',
    example: 'Solicitação do cliente — evento adiado sem nova data',
    minLength: 3,
    maxLength: 500,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  /**
   * Override de proteção financeira: permite executar o estorno mesmo que o saldo
   * do organizador no evento não cubra o valor (saldoParaSaque ficará negativo).
   * Default: false — o endpoint retorna 409 e exige confirmação explícita.
   */
  @ApiPropertyOptional({
    description: 'Forçar estorno mesmo se o saldo do organizador não cobrir o valor',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
