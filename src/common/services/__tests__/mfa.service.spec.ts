import * as speakeasy from 'speakeasy';
import { BadRequestException } from '@nestjs/common';
import { MFAService } from '../mfa.service';

/*
 * ============================================================================
 * ROTEIRO (em português leigo) — o que este teste verifica
 * ============================================================================
 *
 * O MFAService cuida do "segundo fator" de login (aquele código de 6 dígitos
 * que o app autenticador, tipo Google Authenticator, gera e troca a cada 30s).
 * Ele usa a biblioteca `speakeasy` por baixo dos panos.
 *
 * Aqui testamos só o comportamento REAL e determinístico do serviço:
 *
 * 1) GERAR SEGREDO (generateTOTPSecret)
 *    - Cria um "segredo" secreto do usuário, a URL otpauth (que vira o QR Code)
 *      e a imagem do QR Code em formato data:image. Conferimos formato/length.
 *
 * 2) VERIFICAR CÓDIGO (verifyTOTPCode)
 *    - Geramos um código a partir do MESMO segredo com a própria lib e
 *      conferimos que ele é aceito. Um código errado é recusado. Nunca explode.
 *
 * 3) GERAR CÓDIGO (generateTOTPCode)
 *    - Devolve sempre 6 dígitos; com segredo inválido, lança erro tratado.
 *
 * 4) VALIDAR SEGREDO (validateTOTPSecret) — formato base32 válido x lixo.
 *
 * 5) BACKUP CODES — geração (quantidade/formato), hash (sha256), verificação
 *    (acerto x erro) e remoção do código usado.
 *
 * 6) REGRAS DE NEGÓCIO simples e puras: obrigatoriedade por papel (admin),
 *    validação do formato do token digitado (6 dígitos, sem sequência óbvia),
 *    tempo restante do código e os presets de configuração de MFA.
 *
 * O serviço não recebe nenhum provider injetado (construtor vazio), então
 * instanciamos direto. Silenciamos o Logger para não poluir a saída.
 * ============================================================================
 */

describe('MFAService (autenticação de dois fatores — TOTP/MFA)', () => {
  let service: MFAService;

  beforeEach(() => {
    service = new MFAService();
    // Silencia o Logger interno (apenas ruído nos testes).
    jest
      .spyOn((service as any).logger, 'log')
      .mockImplementation(() => undefined);
    jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
    jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);
  });

  describe('generateTOTPSecret — geração do segredo + QR Code', () => {
    it('gera segredo base32, URL otpauth e QR Code em data URL', async () => {
      const out = await service.generateTOTPSecret(
        'user-123',
        'fulano@exemplo.com',
      );

      // Segredo: string base32 não vazia (alfabeto A-Z 2-7).
      expect(typeof out.secret).toBe('string');
      expect(out.secret.length).toBeGreaterThan(0);
      expect(out.secret).toMatch(/^[A-Z2-7]+$/);

      // URL otpauth no formato esperado, com issuer e o e-mail no label.
      expect(out.qrCodeUrl.startsWith('otpauth://totp/')).toBe(true);
      expect(out.qrCodeUrl).toContain('secret=');
      expect(out.qrCodeUrl).toContain('issuer=Loot4Fun');
      expect(decodeURIComponent(out.qrCodeUrl)).toContain('fulano@exemplo.com');

      // QR Code renderizado como imagem PNG em base64 (data URL).
      expect(out.qrCodeDataURL.startsWith('data:image/png;base64,')).toBe(true);
    });

    it('cada chamada produz um segredo diferente (não é determinístico)', async () => {
      const a = await service.generateTOTPSecret('u', 'a@a.com');
      const b = await service.generateTOTPSecret('u', 'a@a.com');
      expect(a.secret).not.toBe(b.secret);
    });

    it('falha na geração do QR Code vira BadRequestException', async () => {
      const qrcode = require('qrcode');
      jest
        .spyOn(qrcode, 'toDataURL')
        .mockRejectedValueOnce(new Error('boom'));

      await expect(
        service.generateTOTPSecret('u', 'a@a.com'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('verifyTOTPCode — verificação do código TOTP', () => {
    it('aceita um código gerado a partir do MESMO segredo (determinístico via lib)', () => {
      const { base32: secret } = speakeasy.generateSecret({ length: 32 });
      // Geramos o código corrente com a própria lib e conferimos que valida.
      const token = speakeasy.totp({ secret, encoding: 'base32' });

      expect(service.verifyTOTPCode(secret, token)).toBe(true);
    });

    it('aceita código dentro da janela de tolerância (±1 passo de 30s)', () => {
      const { base32: secret } = speakeasy.generateSecret({ length: 32 });
      // Código do passo anterior (30s atrás) deve passar por causa de window: 2.
      const tokenAnterior = speakeasy.totp({
        secret,
        encoding: 'base32',
        time: Math.floor(Date.now() / 1000) - 30,
      });

      expect(service.verifyTOTPCode(secret, tokenAnterior)).toBe(true);
    });

    it('recusa um código errado', () => {
      const { base32: secret } = speakeasy.generateSecret({ length: 32 });
      const correto = speakeasy.totp({ secret, encoding: 'base32' });
      // Garante um código diferente do correto (6 dígitos).
      const errado = correto === '000000' ? '111111' : '000000';

      expect(service.verifyTOTPCode(secret, errado)).toBe(false);
    });

    it('token vazio → recusa (false), não lança', () => {
      const { base32: secret } = speakeasy.generateSecret({ length: 32 });
      expect(service.verifyTOTPCode(secret, '')).toBe(false);
    });

    it('segredo inválido/vazio → false (erro tratado internamente)', () => {
      // Segredo vazio + token vazio não deve nunca explodir para o chamador.
      expect(service.verifyTOTPCode('', '123456')).toBe(false);
    });
  });

  describe('generateTOTPCode — geração do código corrente', () => {
    it('gera um código de 6 dígitos a partir do segredo', () => {
      const { base32: secret } = speakeasy.generateSecret({ length: 32 });
      const code = service.generateTOTPCode(secret);

      expect(code).toMatch(/^\d{6}$/);
    });

    it('código gerado pelo serviço é aceito pela verificação do serviço (ida e volta)', () => {
      const { base32: secret } = speakeasy.generateSecret({ length: 32 });
      const code = service.generateTOTPCode(secret);

      expect(service.verifyTOTPCode(secret, code)).toBe(true);
    });
  });

  describe('validateTOTPSecret — validação de formato do segredo', () => {
    /*
     * ⚠️ BUG DE PRODUÇÃO DETECTADO (mfa.service.ts:95).
     * O método chama `speakeasy.otpauthURL.parse(...)`, mas essa função NÃO
     * existe na lib speakeasy (`speakeasy.otpauthURL.parse` é undefined).
     * Resultado: SEMPRE cai no catch e retorna `false`, mesmo para um segredo
     * base32 perfeitamente válido. Ou seja, `validateTOTPSecret` está quebrado
     * e nunca valida nada como verdadeiro.
     *
     * Os testes abaixo documentam o COMPORTAMENTO ATUAL (real) para travar a
     * regressão. Quando o bug for corrigido (ex.: validar via regex base32 ou
     * `speakeasy.otpauthURL({...})` montando a URL), o primeiro caso deve
     * passar a esperar `true`.
     */
    it('[BUG conhecido] segredo base32 válido retorna false (parse inexistente na lib)', () => {
      const { base32: secret } = speakeasy.generateSecret({ length: 32 });
      expect(service.validateTOTPSecret(secret)).toBe(false);
    });

    it('rejeita lixo / string vazia', () => {
      expect(service.validateTOTPSecret('')).toBe(false);
      expect(service.validateTOTPSecret('!!!nao-base32!!!')).toBe(false);
    });
  });

  describe('isMFARequired — obrigatoriedade por papel', () => {
    it('admin e superadmin são obrigados a usar MFA', () => {
      expect(service.isMFARequired('u', 'admin')).toBe(true);
      expect(service.isMFARequired('u', 'superadmin')).toBe(true);
    });

    it('usuário comum não é obrigado por padrão', () => {
      expect(service.isMFARequired('u', 'user')).toBe(false);
    });
  });

  describe('backup codes — geração, hash, verificação e remoção', () => {
    it('gera a quantidade pedida de códigos alfanuméricos em MAIÚSCULAS', () => {
      const codes = service.generateBackupCodes(5);
      expect(codes).toHaveLength(5);
      for (const c of codes) {
        expect(c).toMatch(/^[0-9A-Z]+$/);
        expect(c.length).toBeGreaterThan(0);
      }
    });

    it('quantidade padrão é 8 códigos', () => {
      expect(service.generateBackupCodes()).toHaveLength(8);
    });

    it('hashBackupCodes produz sha256 (64 chars hex) e não guarda o texto puro', () => {
      const codes = ['ABC123', 'XYZ789'];
      const hashed = service.hashBackupCodes(codes);

      expect(hashed).toHaveLength(2);
      for (const h of hashed) {
        expect(h).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(hashed).not.toContain('ABC123');
    });

    it('verifyBackupCode aceita um código cujo hash está na lista', () => {
      const codes = ['ABC123', 'XYZ789'];
      const hashed = service.hashBackupCodes(codes);

      expect(service.verifyBackupCode('ABC123', hashed)).toBe(true);
    });

    it('verifyBackupCode recusa código que não está na lista', () => {
      const hashed = service.hashBackupCodes(['ABC123']);
      expect(service.verifyBackupCode('NAOEXISTE', hashed)).toBe(false);
    });

    it('removeUsedBackupCode remove apenas o hash do código usado', () => {
      const codes = ['ABC123', 'XYZ789'];
      const hashed = service.hashBackupCodes(codes);
      const hashRestante = service.hashBackupCodes(['XYZ789'])[0];

      const restante = service.removeUsedBackupCode('ABC123', hashed);

      expect(restante).toHaveLength(1);
      expect(restante).toEqual([hashRestante]);
      // E o código removido não verifica mais.
      expect(service.verifyBackupCode('ABC123', restante)).toBe(false);
    });
  });

  describe('validateTOTPToken — sanidade do token digitado pelo usuário', () => {
    it('aceita 6 dígitos que não sejam sequência óbvia', () => {
      expect(service.validateTOTPToken('493028')).toEqual({ isValid: true });
    });

    it('rejeita token com menos/mais de 6 dígitos ou com letras', () => {
      expect(service.validateTOTPToken('123').isValid).toBe(false);
      expect(service.validateTOTPToken('1234567').isValid).toBe(false);
      expect(service.validateTOTPToken('12a456').isValid).toBe(false);
      expect(service.validateTOTPToken('').isValid).toBe(false);
    });

    it('rejeita sequências/padrões óbvios (123456, 000000, etc.)', () => {
      for (const t of ['123456', '654321', '000000', '111111', '222222']) {
        const r = service.validateTOTPToken(t);
        expect(r.isValid).toBe(false);
        expect(r.error).toBeDefined();
      }
    });
  });

  describe('getRemainingTime — segundos restantes do código atual', () => {
    it('retorna um valor entre 1 e 30 (janela de 30s)', () => {
      const restante = service.getRemainingTime();
      expect(restante).toBeGreaterThanOrEqual(1);
      expect(restante).toBeLessThanOrEqual(30);
    });

    it('calcula a partir do relógio (mockando o tempo dá valor exato)', () => {
      // Em t = 70s do epoch: 70 % 30 = 10 → faltam 30 - 10 = 20s.
      jest.spyOn(Date, 'now').mockReturnValue(70_000);
      expect(service.getRemainingTime()).toBe(20);
    });
  });

  describe('getMFAConfig — presets por cenário', () => {
    it('admin: obrigatório, 3 tentativas, lockout 15min', () => {
      expect(service.getMFAConfig('admin')).toEqual({
        required: true,
        backupCodesEnabled: true,
        maxAttempts: 3,
        lockoutTime: 15 * 60 * 1000,
      });
    });

    it('user: opcional, 5 tentativas, lockout 5min', () => {
      expect(service.getMFAConfig('user')).toEqual({
        required: false,
        backupCodesEnabled: true,
        maxAttempts: 5,
        lockoutTime: 5 * 60 * 1000,
      });
    });

    it('recovery: obrigatório, sem backup codes, lockout 30min', () => {
      expect(service.getMFAConfig('recovery')).toEqual({
        required: true,
        backupCodesEnabled: false,
        maxAttempts: 3,
        lockoutTime: 30 * 60 * 1000,
      });
    });
  });
});
