/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: a "proteção contra SSRF" — um porteiro que olha as requisições e
 *           barra links/endereços que tentem fazer o servidor falar com a rede
 *           interna/privada (ex.: 127.0.0.1, 192.168.x.x) ou usar protocolos
 *           estranhos. SSRF = Server-Side Request Forgery, quando alguém engana
 *           o servidor para acessar coisas que só ele enxerga por dentro.
 *
 *  ONDE ELE OLHA:
 *    • Nos parâmetros da URL (query, ex.: ?url=...) e da rota (params),
 *      MAS só em campos cujo NOME pareça de link (url, uri, link, redirect,
 *      callback, webhook, endpoint, target, destination, rpc, api).
 *    • No corpo (body) da requisição: varre TODO texto (inclusive aninhado em
 *      objetos/arrays) que pareça uma URL http/https e valida.
 *
 *  O QUE PASSA (next é chamado, sem erro):
 *    • Requisição sem nada suspeito.
 *    • Campo de URL com link público válido (ex.: https://www.exemplo.com).
 *    • Domínio explicitamente confiável (allowlist, ex.: api.loot4.fun).
 *    • Campo cujo nome NÃO parece de link → nem é inspecionado.
 *    • Texto que não é URL (sem http/https) no body → ignorado.
 *
 *  O QUE É BARRADO (lança BadRequestException, mensagem amigável em PT-BR):
 *    • Protocolo não permitido (ex.: ftp://, file://) num campo de URL.
 *    • Endereço apontando para IP privado/interno (ex.: http://192.168.0.1).
 *    • "Domínio" que não é um domínio público válido (ex.: http://semponto).
 *
 *  DETALHE FINO: se a string nem dá pra virar URL (parse falha) o middleware
 *  apenas LOGA um aviso e deixa passar — não é trabalho dele validar formato
 *  de qualquer texto, só barrar SSRF de coisas que SÃO URLs.
 * ============================================================================
 */
import { BadRequestException } from '@nestjs/common';
import { SSRFProtectionMiddleware } from '../ssrf-protection.middleware';

// req/res/next falsos mínimos — o middleware aqui só usa req.query/req.params/req.body
// e chama next() no fim. res nunca é tocado (erros saem por exceção).
const makeReq = (over: any = {}) => ({ query: {}, params: {}, body: undefined, ...over });
const makeRes = () => ({} as any);

describe('SSRFProtectionMiddleware (porteiro anti-SSRF)', () => {
  let mw: SSRFProtectionMiddleware;
  let next: jest.Mock;

  beforeEach(() => {
    mw = new SSRFProtectionMiddleware();
    next = jest.fn();
    // Silencia os logs do middleware para não poluir a saída do teste.
    jest.spyOn((mw as any).logger, 'log').mockImplementation(() => undefined);
    jest.spyOn((mw as any).logger, 'warn').mockImplementation(() => undefined);
  });

  // helper: roda o middleware e captura se houve exceção
  const run = (req: any) => mw.use(req as any, makeRes(), next);

  describe('requisições legítimas passam (next é chamado)', () => {
    it('requisição totalmente vazia → passa', () => {
      run(makeReq());
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('query com campo de URL apontando para domínio público válido → passa', () => {
      run(makeReq({ query: { url: 'https://www.exemplo.com/pagina' } }));
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('query com domínio da allowlist (api.loot4.fun) → passa', () => {
      run(makeReq({ query: { webhook: 'https://api.loot4.fun/hooks' } }));
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('campo cujo nome NÃO parece de link nem é inspecionado → passa mesmo com IP interno', () => {
      // "name" não está na lista de parâmetros de URL → o valor nem é validado.
      run(makeReq({ query: { name: 'http://192.168.0.1/interno' } }));
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('valor de query que não é string (array) é ignorado → passa', () => {
      // Express pode entregar arrays em query; o middleware só valida strings.
      run(makeReq({ query: { url: ['http://192.168.0.1'] } }));
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('body com texto comum (sem http/https) é ignorado → passa', () => {
      run(makeReq({ body: { titulo: 'um texto qualquer sem link', nota: 'abc' } }));
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('body com URL pública válida aninhada em objeto → passa', () => {
      run(makeReq({ body: { perfil: { website: 'https://www.exemplo.com' } } }));
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('body com URL pública válida dentro de array de objetos → passa', () => {
      run(makeReq({ body: { links: [{ href: 'https://www.exemplo.com' }] } }));
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('param de rota com domínio confiável (localhost) → passa', () => {
      run(makeReq({ params: { redirect: 'http://localhost:3000/callback' } }));
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('string que parece link mas não dá pra virar URL → apenas loga e passa', () => {
      // "http://" sem host: o parse falha e o middleware só emite warn, sem barrar.
      run(makeReq({ query: { url: 'http://' } }));
      expect(next).toHaveBeenCalledTimes(1);
      expect((mw as any).logger.warn).toHaveBeenCalled();
    });
  });

  describe('entradas maliciosas/bloqueadas são barradas (BadRequestException)', () => {
    it('protocolo não permitido (ftp://) em campo de URL → barra', () => {
      expect(() => run(makeReq({ query: { url: 'ftp://www.exemplo.com/arquivo' } }))).toThrow(
        BadRequestException,
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('mensagem do protocolo inválido é amigável e cita o campo', () => {
      try {
        run(makeReq({ query: { callback: 'ftp://www.exemplo.com' } }));
        throw new Error('deveria ter lançado');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const msg = (err as BadRequestException).message;
        expect(msg).toContain('"callback"');
        expect(msg).toMatch(/protocolo não permitido/i);
      }
    });

    it('IP privado 192.168.x em campo de URL → barra como servidor interno', () => {
      try {
        run(makeReq({ query: { url: 'http://192.168.0.1/admin' } }));
        throw new Error('deveria ter lançado');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).message).toMatch(/servidor interno\/privado/i);
      }
      expect(next).not.toHaveBeenCalled();
    });

    it('IP privado 10.x em campo de URL → barra', () => {
      expect(() => run(makeReq({ query: { target: 'http://10.1.2.3:8080/' } }))).toThrow(
        BadRequestException,
      );
    });

    it('IP privado 172.16-31.x em campo de URL → barra', () => {
      expect(() => run(makeReq({ query: { url: 'http://172.20.0.5/' } }))).toThrow(
        BadRequestException,
      );
    });

    it('APIPA 169.254.x em campo de URL → barra (metadados de nuvem)', () => {
      // 169.254.169.254 é o endereço clássico de metadados em cloud — alvo de SSRF.
      expect(() => run(makeReq({ query: { url: 'http://169.254.169.254/latest/meta-data' } }))).toThrow(
        BadRequestException,
      );
    });

    it('"domínio" sem ponto (não público válido) → barra', () => {
      try {
        run(makeReq({ query: { url: 'http://servidorinterno/recurso' } }));
        throw new Error('deveria ter lançado');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).message).toMatch(/não é válido/i);
      }
    });

    it('SSRF escondido no body (IP privado) também é barrado', () => {
      expect(() =>
        run(makeReq({ body: { config: { webhookUrl: 'http://192.168.1.10/hook' } } })),
      ).toThrow(BadRequestException);
      expect(next).not.toHaveBeenCalled();
    });

    it('SSRF escondido em array no body é barrado', () => {
      expect(() =>
        run(makeReq({ body: { urls: ['https://www.exemplo.com', 'http://10.0.0.1/'] } })),
      ).toThrow(BadRequestException);
    });

    it('param de rota com nome de link e IP privado → barra', () => {
      // OBS.: 127.0.0.1/localhost estão na ALLOWLIST (uso em dev), então passam.
      // Para exercitar o bloqueio de IP privado usamos um range que NÃO está lá.
      expect(() => run(makeReq({ params: { endpoint: 'http://192.168.1.50:9000/' } }))).toThrow(
        BadRequestException,
      );
    });
  });

  describe('edge cases', () => {
    it('IP público (não privado) em campo de URL → passa', () => {
      // 8.8.8.8 é público; o middleware só barra ranges privados/reservados conhecidos.
      run(makeReq({ query: { url: 'http://8.8.8.8/' } }));
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('body undefined → não quebra, passa', () => {
      run(makeReq({ body: undefined }));
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('body string (não objeto) → não é varrido, passa', () => {
      // use() só varre body quando é objeto; string crua passa direto.
      run(makeReq({ body: 'http://192.168.0.1' as any }));
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('texto longo demais (>4096) no body não é tratado como URL → passa', () => {
      const huge = 'https://www.exemplo.com/' + 'a'.repeat(5000);
      run(makeReq({ body: { campo: huge } }));
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('nome de campo case-insensitive (URL maiúsculo) ainda é inspecionado → barra IP privado', () => {
      // isURLParameter usa toLowerCase(), então "URL" também conta.
      expect(() => run(makeReq({ query: { URL: 'http://192.168.0.1/' } }))).toThrow(
        BadRequestException,
      );
    });

    it('nome de campo que CONTÉM "url" (ex.: imageUrl) é inspecionado → barra IP privado', () => {
      expect(() => run(makeReq({ query: { imageUrl: 'http://10.0.0.9/' } }))).toThrow(
        BadRequestException,
      );
    });

    it('allowlist VENCE o bloqueio de IP: 127.0.0.1 passa (liberado p/ dev)', () => {
      // 127.0.0.1 está em allowedDomains; a checagem de allowlist roda ANTES de
      // isBlockedIP, então o loopback é liberado de propósito (uso em desenvolvimento).
      run(makeReq({ query: { url: 'http://127.0.0.1:3000/' } }));
      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
