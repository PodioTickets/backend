/**
 * Validação de documentos (CPF/CNPJ) pelo algoritmo da Receita Federal.
 *
 * Centralizado em `common/` para reuso entre DTOs e services (o `isValidCpf`
 * legado vivia privado em `auth/dto/auth.dto.ts`; o backend NÃO tinha validação
 * de CNPJ — só o front). Recebe valores com ou sem máscara (limpa não-dígitos).
 */

/** CPF: módulo 11 nos 9 primeiros dígitos → 1º DV; nos 10 → 2º DV. */
export function isValidCpf(value: string | null | undefined): boolean {
  const cpf = (value ?? '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (factor: number): number => {
    let sum = 0;
    for (let i = 0; i < factor - 1; i++) sum += parseInt(cpf[i], 10) * (factor - i);
    const remainder = (sum * 10) % 11;
    return remainder >= 10 ? 0 : remainder;
  };
  return calc(10) === parseInt(cpf[9], 10) && calc(11) === parseInt(cpf[10], 10);
}

/**
 * CNPJ: módulo 11 com pesos 2..9 cíclicos sobre os 12 primeiros dígitos → 1º DV;
 * sobre os 13 → 2º DV. Não basta ter 14 dígitos.
 */
export function isValidCnpj(value: string | null | undefined): boolean {
  const cnpj = (value ?? '').replace(/\D/g, '');
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const checkDigit = (len: number): number => {
    let sum = 0;
    let weight = len - 7;
    for (let i = 0; i < len; i++) {
      sum += parseInt(cnpj.charAt(i), 10) * weight;
      weight = weight === 2 ? 9 : weight - 1;
    }
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return (
    checkDigit(12) === parseInt(cnpj.charAt(12), 10) &&
    checkDigit(13) === parseInt(cnpj.charAt(13), 10)
  );
}

/**
 * Valida CPF (11 dígitos) OU CNPJ (14) pelo tamanho. Aceita com/sem máscara.
 * Vazio/tamanho inesperado → `false`. Útil quando o tipo do documento não é
 * conhecido a priori (ex.: titular de chave PIX pode ser PF ou PJ).
 */
export function isValidCpfOrCnpj(value: string | null | undefined): boolean {
  const digits = (value ?? '').replace(/\D/g, '');
  if (digits.length === 11) return isValidCpf(digits);
  if (digits.length === 14) return isValidCnpj(digits);
  return false;
}
