import { sanitizeRelativePath } from '../safe-redirect.util';

describe('sanitizeRelativePath (open-redirect guard)', () => {
  describe('aceita caminhos relativos da SPA', () => {
    it('caminho simples', () => {
      expect(sanitizeRelativePath('/checkout/ingressos?eventId=XYZ')).toBe('/checkout/ingressos?eventId=XYZ');
    });
    it('raiz', () => {
      expect(sanitizeRelativePath('/')).toBe('/');
    });
    it('com hash', () => {
      expect(sanitizeRelativePath('/eventos/abc#section')).toBe('/eventos/abc#section');
    });
  });

  describe('rejeita destinos potencialmente externos / perigosos', () => {
    it.each([
      ['vazio', ''],
      ['null', null],
      ['undefined', undefined],
      ['absoluto http', 'http://evil.com'],
      ['absoluto https', 'https://evil.com/path'],
      ['protocol-relative //host', '//evil.com'],
      ['backslash /\\host', '/\\evil.com'],
      ['javascript:', 'javascript:alert(1)'],
      ['data:', 'data:text/html,<script>'],
      ['mailto:', 'mailto:a@b.com'],
      ['não começa com /', 'checkout/ingressos'],
      ['espaço no início', ' /checkout'],
    ])('rejeita %s', (_label, input) => {
      expect(sanitizeRelativePath(input as any)).toBeNull();
    });

    it('rejeita CR/LF (header/redirect injection)', () => {
      expect(sanitizeRelativePath('/checkout\r\nSet-Cookie: x=1')).toBeNull();
      expect(sanitizeRelativePath('/checkout\nLocation: http://evil')).toBeNull();
    });

    it('rejeita caractere de controle (\\x00)', () => {
      expect(sanitizeRelativePath('/checkout\x00')).toBeNull();
    });
  });
});
