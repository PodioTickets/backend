import type { Request, Response } from 'express';
import {
  resolveAuthSurface,
  accessCookieName,
  refreshCookieName,
  sessionHintCookieName,
  setAuthCookies,
  clearAuthCookies,
  applyAuthCookiesFromResult,
  SURFACE_HEADER,
} from '../auth-cookies.util';

const mkReq = (surface?: string): Request =>
  ({ headers: surface ? { [SURFACE_HEADER]: surface } : {} } as any as Request);

const mkRes = () => {
  const cookie = jest.fn();
  const clearCookie = jest.fn();
  return { res: { cookie, clearCookie } as unknown as Response, cookie, clearCookie };
};

describe('auth-cookies.util — sessões isoladas por superfície', () => {
  describe('resolveAuthSurface', () => {
    it('lê o header x-pt-surface', () => {
      expect(resolveAuthSurface(mkReq('admin'))).toBe('admin');
      expect(resolveAuthSurface(mkReq('organizer'))).toBe('organizer');
      expect(resolveAuthSurface(mkReq('client'))).toBe('client');
    });
    it('case-insensitive + trim', () => {
      expect(resolveAuthSurface(mkReq('  ADMIN '))).toBe('admin');
    });
    it('header ausente ou inválido → client (default)', () => {
      expect(resolveAuthSurface(mkReq())).toBe('client');
      expect(resolveAuthSurface(mkReq('bogus'))).toBe('client');
    });
  });

  describe('nomes de cookie por superfície', () => {
    it('são distintos por superfície', () => {
      expect(accessCookieName('admin')).toBe('pt_at_admin');
      expect(refreshCookieName('organizer')).toBe('pt_rt_organizer');
      expect(sessionHintCookieName('client')).toBe('pt_authed_client');
    });
  });

  describe('setAuthCookies', () => {
    it('seta os 3 cookies DA superfície + limpa o legado compartilhado', () => {
      const { res, cookie, clearCookie } = mkRes();
      setAuthCookies(res, 'organizer', 'AT', 'RT');

      const names = cookie.mock.calls.map((c) => c[0]);
      expect(names).toEqual([
        'pt_at_organizer',
        'pt_rt_organizer',
        'pt_authed_organizer',
      ]);
      // hint é não-httpOnly; tokens são httpOnly
      const hintOpts = cookie.mock.calls.find((c) => c[0] === 'pt_authed_organizer')![2];
      expect(hintOpts.httpOnly).toBe(false);
      const atOpts = cookie.mock.calls.find((c) => c[0] === 'pt_at_organizer')![2];
      expect(atOpts.httpOnly).toBe(true);
      // legado compartilhado é limpo (não sombrear)
      const cleared = clearCookie.mock.calls.map((c) => c[0]);
      expect(cleared).toEqual(
        expect.arrayContaining(['access_token', 'refresh_token', 'pt_authed']),
      );
    });

    it('NÃO toca nos cookies das OUTRAS superfícies', () => {
      const { res, cookie } = mkRes();
      setAuthCookies(res, 'admin', 'AT', 'RT');
      const names = cookie.mock.calls.map((c) => c[0]);
      expect(names).not.toContain('pt_at_organizer');
      expect(names).not.toContain('pt_at_client');
    });
  });

  describe('clearAuthCookies', () => {
    it('limpa só os cookies da superfície (+ legado)', () => {
      const { res, clearCookie } = mkRes();
      clearAuthCookies(res, 'client');
      const cleared = clearCookie.mock.calls.map((c) => c[0]);
      expect(cleared).toEqual(
        expect.arrayContaining(['pt_at_client', 'pt_rt_client', 'pt_authed_client']),
      );
      expect(cleared).not.toContain('pt_at_admin');
    });
  });

  describe('applyAuthCookiesFromResult', () => {
    it('aplica tokens do result na superfície dada', () => {
      const { res, cookie } = mkRes();
      const result = { data: { access_token: 'AT', refresh_token: 'RT', user: {} } };
      const out = applyAuthCookiesFromResult(res, 'admin', result);
      expect(out).toBe(result);
      expect(cookie.mock.calls.map((c) => c[0])).toEqual([
        'pt_at_admin',
        'pt_rt_admin',
        'pt_authed_admin',
      ]);
    });
    it('no-op quando não há tokens (ex.: desafio MFA)', () => {
      const { res, cookie } = mkRes();
      applyAuthCookiesFromResult(res, 'admin', { mfaRequired: true, mfaToken: 'x' });
      expect(cookie).not.toHaveBeenCalled();
    });
  });
});
