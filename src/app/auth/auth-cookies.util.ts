import type { Response } from 'express';

/**
 * Cookies de autenticação httpOnly.
 *
 * Motivação (2026-06-10): antes os tokens iam no corpo JSON e o frontend os
 * gravava via `js-cookie` (legível por JS) → XSS poderia roubar a sessão.
 * Agora o backend seta o token em cookie `httpOnly`, invisível ao JS. O front
 * para de gerenciar token; o cookie viaja sozinho (axios `withCredentials`).
 *
 * SameSite=Lax (NÃO Strict): a sessão precisa sobreviver ao retorno de redirects
 * top-level cross-site — o challenge 3DS (ACS do banco) e o callback do Google
 * OAuth voltam por navegação top-level. Com `Strict` o cookie seria descartado
 * nesse retorno e o checkout/login quebraria. `Lax` ainda barra CSRF nos POST
 * cross-site (que é o vetor perigoso).
 *
 * Domain: em produção, app e API são subdomínios distintos
 * (app.* vs api.podioticket.com.br). Para o middleware do front (proxy.ts) ler
 * o cookie no host da app, ele precisa ser de domínio-pai
 * (`COOKIE_DOMAIN=.podioticket.com.br`). Em dev (localhost:porta) o cookie de
 * host já é compartilhado entre portas — deixar `COOKIE_DOMAIN` vazio.
 */

export const ACCESS_TOKEN_COOKIE = 'access_token';
export const REFRESH_TOKEN_COOKIE = 'refresh_token';
/**
 * Cookie-dica de sessão: NÃO-httpOnly, NÃO-secreto (valor fixo "1"). Só sinaliza
 * ao frontend "provavelmente logado" para evitar um GET /profile (401) a cada
 * visita anônima. Não dá acesso a nada — o token de verdade segue httpOnly.
 */
export const SESSION_HINT_COOKIE = 'pt_authed';

const ACCESS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias (mirror do legado)
const REFRESH_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 dias

function baseCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  // Front e API precisam ser SAME-SITE para o cookie fluir com SameSite=Lax:
  //  - PROD: app./api.<domínio> são subdomínios do mesmo site → Lax + COOKIE_DOMAIN
  //    (ex.: `.podioticket.com.br`) cobre todos os subdomínios; Secure (https).
  //  - DEV: rode front e API no MESMO host (localhost:3000 ↔ localhost:3333) ou em
  //    subdomínios de um domínio real de dev (*.lvh.me) com COOKIE_DOMAIN=.lvh.me.
  //    `*.localhost` NÃO funciona: o browser não compartilha cookie entre
  //    `localhost` e `test890.localhost`/`app.localhost`.
  const domain = process.env.COOKIE_DOMAIN?.trim() || ".podioticket.com.br".trim();
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    domain,
    path: '/',
  };
}

/** Seta access + refresh token como cookies httpOnly na resposta. */
export function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken?: string | null,
): void {
  const base = baseCookieOptions();
  if (accessToken) {
    res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
      ...base,
      maxAge: ACCESS_MAX_AGE_MS,
    });
  }
  if (refreshToken) {
    res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
      ...base,
      maxAge: REFRESH_MAX_AGE_MS,
    });
  }
  // Dica de sessão legível por JS (sem segredo): o front a usa só para decidir
  // se vale chamar /profile. Mesma janela do refresh.
  res.cookie(SESSION_HINT_COOKIE, '1', {
    ...base,
    httpOnly: false,
    maxAge: REFRESH_MAX_AGE_MS,
  });
}

/** Limpa os cookies de auth (logout). Mesmas flags de domínio/path do set. */
export function clearAuthCookies(res: Response): void {
  const { httpOnly, secure, sameSite, domain, path } = baseCookieOptions();
  const opts = { httpOnly, secure, sameSite, domain, path };
  res.clearCookie(ACCESS_TOKEN_COOKIE, opts);
  res.clearCookie(REFRESH_TOKEN_COOKIE, opts);
  res.clearCookie(SESSION_HINT_COOKIE, { ...opts, httpOnly: false });
}

/**
 * Aplica cookies de auth a partir de um resultado de login/refresh que carrega
 * `{ data: { access_token, refresh_token } }`. No-op quando o resultado é um
 * desafio MFA (`mfaRequired`) ou não tem tokens. Retorna o próprio resultado
 * para encadear no controller.
 */
export function applyAuthCookiesFromResult<T extends Record<string, any>>(
  res: Response,
  result: T,
): T {
  const data = result?.data ?? result;
  const accessToken = data?.access_token;
  const refreshToken = data?.refresh_token;
  if (accessToken) {
    setAuthCookies(res, accessToken, refreshToken);
  }
  return result;
}
