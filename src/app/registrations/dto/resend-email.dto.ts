import { IsBoolean, IsEmail, IsNotEmpty, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Reenvio do e-mail de confirmação do PEDIDO (todos os ingressos + comprovante)
 * para um endereço arbitrário, acionado pelo comprador/organizador/admin no
 * modal de pedido. Normaliza (trim + lowercase) antes de validar.
 */
export class ResendRegistrationEmailDto {
  @ApiProperty({
    description:
      'E-mail de destino que receberá todos os ingressos + comprovante do pedido.',
    example: 'destino@email.com',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsNotEmpty({ message: 'E-mail é obrigatório' })
  @IsEmail({}, { message: 'E-mail inválido' })
  email: string;

  /**
   * Quando `true`, reenvia SOMENTE o ingresso desta inscrição (sem comprovante e
   * sem os demais ingressos do pedido). Usado pelo modal de inscrição do
   * organizador. Omisso/`false` = fluxo de pedido (todos os ingressos +
   * comprovante).
   */
  @ApiPropertyOptional({
    description:
      'Se true, envia apenas o ingresso desta inscrição (sem comprovante nem demais ingressos do pedido).',
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  ticketOnly?: boolean;
}
