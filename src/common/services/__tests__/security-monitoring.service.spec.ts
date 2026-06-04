/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: o "monitor de segurança". Ele anota cada evento de segurança que
 *           acontece no sistema (tentativa de login, acesso negado, upload
 *           suspeito, etc.), guarda esses eventos em memória, e a partir deles
 *           consegue:
 *             - contar quantos eventos vieram de cada IP (quem mais "bate na
 *               porta"),
 *             - montar um ranking dos IPs mais ativos (top-N),
 *             - DISPARAR UM ALERTA automaticamente quando um evento bate numa
 *               regra de risco (ex.: muitas tentativas de login = força bruta),
 *             - montar um resumo geral (estatísticas) por categoria/gravidade.
 *
 *  EM RESUMO:
 *    Cada vez que algo de segurança acontece, alguém chama `logSecurityEvent`.
 *    O monitor guarda o evento, avisa o resto do sistema (event emitter) e
 *    confere se aquele evento dispara alguma regra de alerta. Se disparar, ele
 *    cria um alerta (e avisa também). Tudo isso é em memória — não há banco.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Registrar um evento: ele entra na lista e é avisado pro resto do sistema.
 *    • Contagem por IP: o ranking (top IPs) soma certo e ordena do maior pro menor.
 *    • Top-N: o ranking respeita o limite pedido (ex.: só os 2 maiores).
 *    • Alerta por limiar: um evento que bate numa regra (ex.: > 5 tentativas)
 *      gera um alerta com a gravidade certa.
 *    • Cooldown: a mesma regra não dispara duas vezes seguidas dentro do intervalo.
 *    • Resumo (estatísticas): conta por categoria e por gravidade, e traz o top IPs.
 *    • Reconhecer alerta: marcar um alerta como "visto" tira ele dos ativos.
 *    • Casos de borda: sem nenhum evento o resumo devolve zeros (não quebra);
 *      evento sem IP não entra na contagem por IP.
 *
 *  COMO CONFERIMOS:
 *    Criamos o monitor com dependências "de mentira" (ConfigService e o
 *    EventEmitter2 são mocks). NÃO chamamos onModuleInit (que liga timers de
 *    fundo) — em vez disso registramos as regras manualmente, para o teste ser
 *    determinístico e sem timers pendurados. Sem banco, sem Redis.
 * ============================================================================
 */
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SecurityMonitoringService } from '../security-monitoring.service';

type EmitterMock = { emit: jest.Mock };

describe('SecurityMonitoringService', () => {
  let service: SecurityMonitoringService;
  let emitter: EmitterMock;

  beforeEach(() => {
    emitter = { emit: jest.fn() };
    const config = { get: jest.fn() } as unknown as ConfigService;

    service = new SecurityMonitoringService(
      config,
      emitter as unknown as EventEmitter2,
    );

    // Silencia o logger pra não poluir a saída dos testes.
    const logger = (service as any).logger;
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    // NÃO chamamos onModuleInit (ligaria setInterval de fundo). Em vez disso,
    // carregamos as regras de alerta manualmente — é o mesmo método privado
    // que o onModuleInit usaria.
    (service as any).initializeAlertRules();
  });

  describe('registro e agregação de eventos', () => {
    it('guarda o evento registrado na lista interna', () => {
      service.logSecurityEvent('info', 'authentication', 'login ok');

      const recent = service.getRecentEvents();
      expect(recent).toHaveLength(1);
      expect(recent[0]).toMatchObject({
        level: 'info',
        category: 'authentication',
        message: 'login ok',
        source: 'system',
      });
      expect(recent[0].timestamp).toBeInstanceOf(Date);
    });

    it('avisa o resto do sistema emitindo "security.event"', () => {
      service.logSecurityEvent('info', 'authentication', 'login ok');

      expect(emitter.emit).toHaveBeenCalledWith(
        'security.event',
        expect.objectContaining({ message: 'login ok' }),
      );
    });

    it('getRecentEvents respeita o limite pedido e traz os mais recentes', () => {
      for (let i = 0; i < 5; i++) {
        service.logSecurityEvent('info', 'misc', `evento ${i}`);
      }

      const recent = service.getRecentEvents(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].message).toBe('evento 3');
      expect(recent[1].message).toBe('evento 4');
    });
  });

  describe('contagem por IP e ranking top-N', () => {
    it('soma os eventos por IP e ordena do maior para o menor', () => {
      // IP "10.0.0.1" aparece 3x, "10.0.0.2" 1x.
      service.logSecurityEvent('info', 'misc', 'a', {}, 'system', undefined, '10.0.0.1');
      service.logSecurityEvent('info', 'misc', 'b', {}, 'system', undefined, '10.0.0.1');
      service.logSecurityEvent('info', 'misc', 'c', {}, 'system', undefined, '10.0.0.1');
      service.logSecurityEvent('info', 'misc', 'd', {}, 'system', undefined, '10.0.0.2');

      const top = (service as any).getTopIPs(10) as Array<{
        ip: string;
        count: number;
      }>;

      expect(top).toEqual([
        { ip: '10.0.0.1', count: 3 },
        { ip: '10.0.0.2', count: 1 },
      ]);
    });

    it('top-N limita a quantidade de IPs retornados', () => {
      service.logSecurityEvent('info', 'misc', 'a', {}, 'system', undefined, '1.1.1.1');
      service.logSecurityEvent('info', 'misc', 'a', {}, 'system', undefined, '1.1.1.1');
      service.logSecurityEvent('info', 'misc', 'b', {}, 'system', undefined, '2.2.2.2');
      service.logSecurityEvent('info', 'misc', 'c', {}, 'system', undefined, '3.3.3.3');

      const top = (service as any).getTopIPs(1) as Array<{
        ip: string;
        count: number;
      }>;

      expect(top).toHaveLength(1);
      expect(top[0]).toEqual({ ip: '1.1.1.1', count: 2 });
    });

    it('eventos sem IP não entram na contagem por IP (edge case)', () => {
      service.logSecurityEvent('info', 'misc', 'sem ip'); // ip = undefined
      service.logSecurityEvent('info', 'misc', 'com ip', {}, 'system', undefined, '9.9.9.9');

      const top = (service as any).getTopIPs(10) as Array<{
        ip: string;
        count: number;
      }>;

      expect(top).toEqual([{ ip: '9.9.9.9', count: 1 }]);
    });
  });

  describe('disparo de alerta ao cruzar limiar', () => {
    it('gera um alerta de força bruta quando attempts > 5', () => {
      service.logSecurityEvent(
        'warning',
        'authentication',
        'too many tries',
        { attempts: 6 },
      );

      const alerts = service.getAllAlerts();
      const bruteForce = alerts.find((a) => a.ruleId === 'brute-force-attack');

      expect(bruteForce).toBeDefined();
      expect(bruteForce!.severity).toBe('high');
      expect(bruteForce!.acknowledged).toBe(false);
      // O alerta também é anunciado pro resto do sistema.
      expect(emitter.emit).toHaveBeenCalledWith(
        'security.alert',
        expect.objectContaining({ ruleId: 'brute-force-attack' }),
      );
    });

    it('NÃO gera alerta de força bruta quando attempts está no limiar (=5)', () => {
      service.logSecurityEvent(
        'warning',
        'authentication',
        'borderline',
        { attempts: 5 },
      );

      const alerts = service.getAllAlerts();
      expect(alerts.find((a) => a.ruleId === 'brute-force-attack')).toBeUndefined();
    });

    it('regra crítica (malware) dispara imediatamente sem cooldown', () => {
      service.logSecurityEvent('error', 'upload', 'malware found in file');

      const malware = service
        .getAllAlerts()
        .find((a) => a.ruleId === 'malware-detected');

      expect(malware).toBeDefined();
      expect(malware!.severity).toBe('critical');
    });

    it('respeita o cooldown: a mesma regra não dispara duas vezes dentro do intervalo', () => {
      // failed-login-attempts tem cooldown de 15 min.
      service.logSecurityEvent('warning', 'authentication', 'failed login #1');
      service.logSecurityEvent('warning', 'authentication', 'failed login #2');

      const failedLoginAlerts = service
        .getAllAlerts()
        .filter((a) => a.ruleId === 'failed-login-attempts');

      expect(failedLoginAlerts).toHaveLength(1);
    });

    it('não dispara alerta para evento que não bate em nenhuma regra', () => {
      service.logSecurityEvent('info', 'misc', 'nada de mais aqui');
      expect(service.getAllAlerts()).toHaveLength(0);
    });
  });

  describe('resumo / estatísticas de segurança', () => {
    it('conta por categoria, por gravidade e inclui o top IPs', () => {
      service.logSecurityEvent('info', 'authentication', 'a', {}, 'system', undefined, '5.5.5.5');
      service.logSecurityEvent('warning', 'authentication', 'b', {}, 'system', undefined, '5.5.5.5');
      service.logSecurityEvent('error', 'upload', 'c', {}, 'system', undefined, '6.6.6.6');

      const stats = service.getSecurityStats();

      expect(stats.summary.totalEvents).toBe(3);
      expect(stats.eventsByCategory).toMatchObject({
        authentication: 2,
        upload: 1,
      });
      expect(stats.eventsByLevel).toMatchObject({
        info: 1,
        warning: 1,
        error: 1,
      });
      expect(stats.topIPs).toContainEqual({ ip: '5.5.5.5', count: 2 });
    });

    it('sem nenhum evento, o resumo devolve zeros e não quebra (edge case)', () => {
      const stats = service.getSecurityStats();

      expect(stats.summary).toMatchObject({
        totalEvents: 0,
        totalAlerts: 0,
        activeAlerts: 0,
        recentEventsLastHour: 0,
        recentAlertsLast24Hours: 0,
      });
      expect(stats.eventsByCategory).toEqual({});
      expect(stats.eventsByLevel).toEqual({});
      expect(stats.topIPs).toEqual([]);
    });
  });

  describe('reconhecimento (acknowledge) de alertas', () => {
    it('marcar um alerta como reconhecido o remove dos ativos', () => {
      service.logSecurityEvent('error', 'upload', 'malware found');
      const alert = service.getAllAlerts()[0];

      expect(service.getActiveAlerts()).toHaveLength(1);

      const ok = service.acknowledgeAlert(alert.id, 'admin-1');

      expect(ok).toBe(true);
      expect(service.getActiveAlerts()).toHaveLength(0);
      const updated = service.getAllAlerts().find((a) => a.id === alert.id)!;
      expect(updated.acknowledged).toBe(true);
      expect(updated.acknowledgedBy).toBe('admin-1');
    });

    it('reconhecer um alerta inexistente devolve false', () => {
      expect(service.acknowledgeAlert('nao-existe', 'admin-1')).toBe(false);
    });
  });

  describe('gerência de regras de alerta', () => {
    it('toggleAlertRule desabilita a regra e ela para de disparar', () => {
      const toggled = service.toggleAlertRule('malware-detected', false);
      expect(toggled).toBe(true);

      service.logSecurityEvent('error', 'upload', 'malware found');

      expect(
        service.getAllAlerts().find((a) => a.ruleId === 'malware-detected'),
      ).toBeUndefined();
    });

    it('removeAlertRule remove a regra e devolve false se não existir', () => {
      expect(service.removeAlertRule('ssrf-attack')).toBe(true);
      expect(service.removeAlertRule('ssrf-attack')).toBe(false);
    });
  });
});
