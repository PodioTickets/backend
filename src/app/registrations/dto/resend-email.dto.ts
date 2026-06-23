import { IsEmail, IsNotEmpty } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

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
}
