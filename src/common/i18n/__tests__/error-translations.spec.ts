import {
  parseErrorLocale,
  translateErrorList,
  translateErrorMessage,
} from '../error-translations';

describe('error-translations', () => {
  describe('parseErrorLocale', () => {
    it('aceita só os valores exatos que o ApiClient manda', () => {
      expect(parseErrorLocale('en')).toBe('en');
      expect(parseErrorLocale('ES')).toBe('es');
      expect(parseErrorLocale('pt-BR')).toBe('pt-BR');
    });

    it('lista do navegador (fetch cru) ou ausente → pt-BR', () => {
      expect(parseErrorLocale('en-US,en;q=0.9')).toBe('pt-BR');
      expect(parseErrorLocale('en-US')).toBe('pt-BR');
      expect(parseErrorLocale(undefined)).toBe('pt-BR');
      expect(parseErrorLocale(['es'])).toBe('es');
    });
  });

  describe('translateErrorMessage', () => {
    it('traduz mensagem exata', () => {
      expect(translateErrorMessage('Cupom expirado', 'en')).toBe('Coupon expired');
      expect(translateErrorMessage('Cupom expirado', 'es')).toBe('Cupón expirado');
    });

    it('pt-BR mantém a mensagem PT original', () => {
      expect(translateErrorMessage('Cupom expirado', 'pt-BR')).toBe('Cupom expirado');
    });

    it('mensagem em inglês ganha versão pt-BR quando mapeada', () => {
      expect(translateErrorMessage('Voucher has expired', 'pt-BR')).toBe('Voucher expirado');
    });

    it('"Validation failed" segue intacto em pt-BR (o painel reconhece o texto)', () => {
      expect(translateErrorMessage('Validation failed', 'pt-BR')).toBe('Validation failed');
      expect(translateErrorMessage('Validation failed', 'es')).toBe('Error de validación');
    });

    it('preenche os trechos variáveis', () => {
      expect(
        translateErrorMessage('Sem vagas disponíveis para o ingresso "5km Kids". Lote esgotado.', 'en'),
      ).toBe('No spots left for the ticket "5km Kids". Sold out.');
      expect(
        translateErrorMessage('Limite de 10 ingressos por pedido excedido. Total solicitado: 12.', 'es'),
      ).toBe('Se superó el límite de 10 entradas por pedido. Solicitadas: 12.');
      expect(translateErrorMessage('Valor mínimo do pedido para este cupom: R$ 50,00', 'en')).toBe(
        'Minimum order value for this coupon: R$ 50,00',
      );
    });

    it('mensagem desconhecida volta como está', () => {
      expect(translateErrorMessage('Algo inédito', 'en')).toBe('Algo inédito');
      expect(translateErrorMessage('', 'en')).toBe('');
    });
  });

  describe('translateErrorList', () => {
    it('traduz strings e objetos { message } e preserva o resto', () => {
      const out = translateErrorList(
        ['CPF inválido', { property: 'email', message: 'E-mail inválido' }, 42],
        'en',
      );
      expect(out).toEqual(['Invalid CPF', { property: 'email', message: 'Invalid email' }, 42]);
    });

    it('não-array passa direto', () => {
      expect(translateErrorList(undefined, 'en')).toBeUndefined();
    });
  });
});
