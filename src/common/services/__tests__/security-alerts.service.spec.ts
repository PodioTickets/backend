import { SecurityAlertsService } from '../security-alerts.service';

/*
 * ============================================================================
 * ROTEIRO (em português leigo) — o que este teste verifica
 * ============================================================================
 *
 * O SecurityAlertsService é o "porteiro de avisos de segurança". Quando algo
 * suspeito acontece no sistema (ex.: muitas tentativas de login, evento
 * crítico), ele decide:
 *
 *   a) PARA QUEM avisar  -> canais cadastrados (email, Slack, Discord, webhook);
 *   b) SE deve avisar    -> compara a GRAVIDADE do alerta com a regra do canal,
 *                           e respeita um tempo de espera (cooldown) pra não
 *                           floodar o mesmo canal repetidamente;
 *   c) COMO avisar       -> monta a mensagem (assunto, cor, emoji, HTML).
 *
 * O ENVIO em si (mandar email pelo SendGrid, ou POST HTTP no Slack/Discord/
 * webhook) é "mundo externo". A gente NÃO quer enviar nada de verdade no teste,
 * então mockamos o `@sendgrid/mail` e o `axios`. Assim testamos só a LÓGICA PURA.
 *
 * Cobrimos:
 *
 * 1) DECISÃO DE GRAVIDADE (isSeverityMatch / mapEventLevelToSeverity)
 *    - alerta só dispara se a gravidade dele for >= a gravidade mínima da regra;
 *    - tradução de "level" do evento (critical/error/warning/info) -> severity.
 *
 * 2) COOLDOWN (isCooldownExpired)
 *    - primeira vez sempre passa; dentro da janela bloqueia; depois libera.
 *
 * 3) DISPARO QUANDO DEVE / NÃO DISPARA QUANDO ABAIXO DO CRITÉRIO
 *    - alerta de gravidade alta chega ao email; alerta baixo NÃO chega ao email
 *      (cuja regra mínima é "high"); evento "info" nem entra na fila.
 *
 * 4) DEDUP / THROTTLE entre dois alertas seguidos no MESMO canal.
 *
 * 5) FORMATAÇÃO (emoji, cor hex, cor numérica, assunto do email, HTML).
 *
 * 6) FAIL-OPEN (à prova de falha): se um canal explode no envio, o serviço
 *    NÃO derruba os outros canais nem propaga a exceção pro chamador. E se o
 *    email estiver desligado (sem SEND_GRID), ele só ignora sem mandar nada.
 *
 * 7) GERÊNCIA DE CANAIS (add/remove/toggle/stats/testChannel) — utilidades.
 *
 * Como instanciamos: o construtor recebe ConfigService e EventEmitter2. Damos
 * mocks simples. O `get` do ConfigService devolve o default passado (segundo
 * argumento) e `undefined` pros canais opcionais (Slack/Discord/webhook), de
 * modo que por padrão só existe o canal de email — fica determinístico.
 * Silenciamos o Logger pra não poluir a saída.
 * ============================================================================
 */

// --- Mocks de mundo externo --------------------------------------------------
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn().mockResolvedValue({ status: 200, data: 'ok' }) },
}));

jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  send: jest.fn().mockResolvedValue([{ statusCode: 202 }]),
}));

// Importes APÓS os mocks pra garantir que o módulo pegue a versão mockada.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const axios = require('axios').default as { post: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sgMail = require('@sendgrid/mail') as { setApiKey: jest.Mock; send: jest.Mock };

type ConfigMap = Record<string, string | undefined>;

/** Cria um ConfigService falso. `map` sobrescreve chaves; senão usa o default. */
function makeConfig(map: ConfigMap = {}) {
  return {
    get: jest.fn((key: string, def?: string) => {
      if (key in map) return map[key];
      return def;
    }),
  } as any;
}

function makeEventEmitter() {
  return { emit: jest.fn(), on: jest.fn() } as any;
}

/** Monta um alerta no formato esperado por handleSecurityAlert. */
function buildAlert(overrides: Partial<any> = {}) {
  return {
    id: 'alert-1',
    title: 'Tentativas suspeitas de login',
    description: 'Muitas falhas de autenticação detectadas',
    severity: 'critical',
    timestamp: new Date('2026-06-03T10:00:00.000Z'),
    metadata: { event: { category: 'auth' }, ip: '1.2.3.4' },
    ...overrides,
  };
}

function silenceLogger(service: SecurityAlertsService) {
  const logger = (service as any).logger;
  jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
}

/**
 * Instancia o serviço e roda onModuleInit (popula canais).
 * Por padrão habilita o email (SEND_GRID setado) e deixa os canais opcionais
 * desligados (Slack/Discord/webhook sem URL).
 */
async function bootstrap(configMap: ConfigMap = {}) {
  const config = makeConfig({ SEND_GRID: 'SG.fake-key', ...configMap });
  const emitter = makeEventEmitter();
  const service = new SecurityAlertsService(config, emitter);
  silenceLogger(service);
  await service.onModuleInit();
  return { service, config, emitter };
}

describe('SecurityAlertsService (porteiro de avisos de segurança)', () => {
  beforeEach(() => {
    axios.post.mockClear();
    axios.post.mockResolvedValue({ status: 200, data: 'ok' });
    sgMail.send.mockClear();
    sgMail.send.mockResolvedValue([{ statusCode: 202 }]);
    sgMail.setApiKey.mockClear();
  });

  // ==========================================================================
  // 1) Inicialização de canais
  // ==========================================================================
  describe('onModuleInit / initializeChannels — montagem dos canais', () => {
    it('com SEND_GRID presente, habilita email e cria só o canal de email por padrão', async () => {
      const { service } = await bootstrap();
      const channels = service.getChannels();
      expect(channels).toHaveLength(1);
      expect(channels[0].type).toBe('email');
      expect((service as any).emailEnabled).toBe(true);
      expect(sgMail.setApiKey).toHaveBeenCalledWith('SG.fake-key');
    });

    it('sem SEND_GRID, mantém email DESABILITADO (fail-safe), mas ainda cria o canal', async () => {
      // override: remove a chave SEND_GRID
      const config = makeConfig({ SEND_GRID: undefined });
      const service = new SecurityAlertsService(config, makeEventEmitter());
      silenceLogger(service);
      await service.onModuleInit();
      expect((service as any).emailEnabled).toBe(false);
      expect(sgMail.setApiKey).not.toHaveBeenCalled();
    });

    it('cria canais opcionais (Slack/Discord/webhook) quando as URLs existem', async () => {
      const { service } = await bootstrap({
        SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x',
        DISCORD_WEBHOOK_URL: 'https://discord.test/y',
        ALERT_WEBHOOK_URL: 'https://webhook.test/z',
      });
      const types = service.getChannels().map((c) => c.type).sort();
      expect(types).toEqual(['discord', 'email', 'slack', 'webhook']);
    });
  });

  // ==========================================================================
  // 2) Tradução de level -> severity
  // ==========================================================================
  describe('mapEventLevelToSeverity — tradução do nível do evento', () => {
    it('mapeia os níveis conhecidos corretamente', async () => {
      const { service } = await bootstrap();
      const map = (service as any).mapEventLevelToSeverity.bind(service);
      expect(map('critical')).toBe('critical');
      expect(map('error')).toBe('high');
      expect(map('warning')).toBe('medium');
      expect(map('info')).toBe('low');
    });

    it('nível desconhecido cai no default "medium"', async () => {
      const { service } = await bootstrap();
      expect((service as any).mapEventLevelToSeverity('qualquer-coisa')).toBe('medium');
    });
  });

  // ==========================================================================
  // 3) Critério de gravidade (>=)
  // ==========================================================================
  describe('isSeverityMatch — regra dispara quando alerta >= mínimo', () => {
    it('alerta de gravidade igual ou maior que a regra: PASSA', async () => {
      const { service } = await bootstrap();
      const match = (service as any).isSeverityMatch.bind(service);
      expect(match('high', 'high')).toBe(true); // igual
      expect(match('high', 'critical')).toBe(true); // maior
      expect(match('low', 'medium')).toBe(true);
    });

    it('alerta abaixo do mínimo da regra: NÃO passa', async () => {
      const { service } = await bootstrap();
      const match = (service as any).isSeverityMatch.bind(service);
      expect(match('high', 'low')).toBe(false);
      expect(match('critical', 'high')).toBe(false);
    });
  });

  // ==========================================================================
  // 4) Cooldown
  // ==========================================================================
  describe('isCooldownExpired — janela de espera por regra', () => {
    it('primeira vez (sem lastTriggered) sempre libera', async () => {
      const { service } = await bootstrap();
      expect((service as any).isCooldownExpired({ cooldown: 60000 })).toBe(true);
    });

    it('dentro da janela BLOQUEIA; após a janela LIBERA', async () => {
      const { service } = await bootstrap();
      const now = 1_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);
      // disparado agora, cooldown de 5 min -> ainda bloqueado
      expect((service as any).isCooldownExpired({ cooldown: 5 * 60 * 1000, lastTriggered: now })).toBe(false);
      // disparado há 6 min -> liberado
      expect(
        (service as any).isCooldownExpired({ cooldown: 5 * 60 * 1000, lastTriggered: now - 6 * 60 * 1000 }),
      ).toBe(true);
    });
  });

  // ==========================================================================
  // 5) Disparo quando deve / não quando abaixo do critério
  // ==========================================================================
  describe('handleSecurityAlert — dispara para os canais corretos', () => {
    it('alerta CRITICAL chega ao email (regra mínima high/critical satisfeita)', async () => {
      const { service } = await bootstrap();
      await service.handleSecurityAlert(buildAlert({ severity: 'critical' }));
      expect(sgMail.send).toHaveBeenCalledTimes(1);
    });

    it('alerta LOW NÃO chega ao email (regra mínima do email é "high")', async () => {
      const { service } = await bootstrap();
      await service.handleSecurityAlert(buildAlert({ severity: 'low' }));
      expect(sgMail.send).not.toHaveBeenCalled();
    });

    it('com Slack configurado (regra mínima "low"), alerta LOW chega ao Slack mas NÃO ao email', async () => {
      const { service } = await bootstrap({ SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' });
      await service.handleSecurityAlert(buildAlert({ severity: 'low' }));
      expect(sgMail.send).not.toHaveBeenCalled();
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post.mock.calls[0][0]).toBe('https://hooks.slack.test/x');
    });
  });

  describe('handleSecurityEvent — só processa eventos critical/error', () => {
    it('evento INFO não dispara nada', async () => {
      const { service } = await bootstrap();
      await service.handleSecurityEvent({
        level: 'info',
        category: 'auth',
        message: 'login ok',
        timestamp: new Date(),
        metadata: {},
        source: 'app',
      });
      expect(sgMail.send).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('evento ERROR vira severity "high" e dispara ao email', async () => {
      const { service } = await bootstrap();
      await service.handleSecurityEvent({
        level: 'error',
        category: 'auth',
        message: 'falha grave',
        timestamp: new Date('2026-06-03T10:00:00.000Z'),
        metadata: { ip: '9.9.9.9' },
        source: 'app',
      });
      expect(sgMail.send).toHaveBeenCalledTimes(1);
      const sent = sgMail.send.mock.calls[0][0];
      // assunto do email começa com o emoji de "high" (laranja)
      expect(sent.subject).toContain('🟠');
    });
  });

  // ==========================================================================
  // 6) Dedup / throttle entre dois alertas seguidos
  // ==========================================================================
  describe('throttle/cooldown na prática — dois alertas seguidos no mesmo canal', () => {
    it('regra com cooldown bloqueia o 2º envio dentro da janela', async () => {
      // Slack tem cooldown de 10min e regra mínima "low".
      const { service } = await bootstrap({ SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' });
      // Desliga o email pra isolar o Slack na contagem do axios (email usa sgMail, não axios — mas garante clareza)
      service.toggleChannel('email-admin', false);

      const base = 5_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(base);

      await service.handleSecurityAlert(buildAlert({ severity: 'high', id: 'a1' }));
      expect(axios.post).toHaveBeenCalledTimes(1);

      // 2º alerta logo em seguida (mesmo instante) -> cooldown ainda ativo -> bloqueado
      await service.handleSecurityAlert(buildAlert({ severity: 'high', id: 'a2' }));
      expect(axios.post).toHaveBeenCalledTimes(1);

      // Avança o relógio além do cooldown (10min + 1s) -> libera o 3º
      (Date.now as jest.Mock).mockReturnValue(base + 10 * 60 * 1000 + 1000);
      await service.handleSecurityAlert(buildAlert({ severity: 'high', id: 'a3' }));
      expect(axios.post).toHaveBeenCalledTimes(2);
    });

    it('regra critical do email tem cooldown 0 -> NÃO faz throttle de críticos consecutivos', async () => {
      const { service } = await bootstrap();
      await service.handleSecurityAlert(buildAlert({ severity: 'critical', id: 'c1' }));
      await service.handleSecurityAlert(buildAlert({ severity: 'critical', id: 'c2' }));
      expect(sgMail.send).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // 7) Formatação
  // ==========================================================================
  describe('formatação — emoji, cor e conteúdo', () => {
    it('getSeverityEmoji devolve o emoji certo por gravidade (e default)', async () => {
      const { service } = await bootstrap();
      const emoji = (service as any).getSeverityEmoji.bind(service);
      expect(emoji('critical')).toBe('🔴');
      expect(emoji('high')).toBe('🟠');
      expect(emoji('medium')).toBe('🟡');
      expect(emoji('low')).toBe('🟢');
      expect(emoji('???')).toBe('⚪');
    });

    it('getSeverityColor devolve hex certo (e default cinza)', async () => {
      const { service } = await bootstrap();
      const color = (service as any).getSeverityColor.bind(service);
      expect(color('critical')).toBe('#dc3545');
      expect(color('high')).toBe('#fd7e14');
      expect(color('medium')).toBe('#ffc107');
      expect(color('low')).toBe('#28a745');
      expect(color('???')).toBe('#6c757d');
    });

    it('getSeverityColorNumber devolve número certo (e default cinza)', async () => {
      const { service } = await bootstrap();
      const num = (service as any).getSeverityColorNumber.bind(service);
      expect(num('critical')).toBe(0xff0000);
      expect(num('high')).toBe(0xffa500);
      expect(num('medium')).toBe(0xffff00);
      expect(num('low')).toBe(0x00ff00);
      expect(num('???')).toBe(0x808080);
    });

    it('assunto do email inclui emoji + título; HTML inclui título/descrição/categoria', async () => {
      // Destinatário vem de ALERT_EMAIL_RECIPIENTS (sem default externo herdado).
      const { service } = await bootstrap({ ALERT_EMAIL_RECIPIENTS: 'sec@podioticket.com.br' });
      await service.handleSecurityAlert(
        buildAlert({ severity: 'critical', title: 'Brute force', description: 'demais falhas' }),
      );
      const payload = sgMail.send.mock.calls[0][0];
      expect(payload.subject).toContain('🔴');
      expect(payload.subject).toContain('Brute force');
      expect(payload.html).toContain('Brute force');
      expect(payload.html).toContain('demais falhas');
      expect(payload.html).toContain('CRITICAL'); // severity em maiúsculas
      expect(payload.to).toEqual(['sec@podioticket.com.br']);
    });

    it('payload do Slack carrega cor e campos de severidade/categoria', async () => {
      const { service } = await bootstrap({ SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' });
      service.toggleChannel('email-admin', false);
      await service.handleSecurityAlert(buildAlert({ severity: 'high', metadata: { event: { category: 'rate-limit' } } }));
      const [, body] = axios.post.mock.calls[0];
      expect(body.attachments[0].color).toBe('#fd7e14');
      const sevField = body.attachments[0].fields.find((f: any) => f.title === 'Severity');
      expect(sevField.value).toBe('HIGH');
      const catField = body.attachments[0].fields.find((f: any) => f.title === 'Category');
      expect(catField.value).toBe('rate-limit');
    });
  });

  // ==========================================================================
  // 8) Fail-open
  // ==========================================================================
  describe('fail-open — falha de canal não derruba o resto nem propaga', () => {
    it('se o envio de email lança, handleSecurityAlert NÃO propaga a exceção', async () => {
      const { service } = await bootstrap();
      sgMail.send.mockRejectedValueOnce(new Error('SendGrid down'));
      await expect(service.handleSecurityAlert(buildAlert({ severity: 'critical' }))).resolves.toBeUndefined();
    });

    it('um canal que falha não impede o outro de receber', async () => {
      const { service } = await bootstrap({ SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' });
      // email falha; slack deve seguir
      sgMail.send.mockRejectedValueOnce(new Error('SendGrid down'));
      await service.handleSecurityAlert(buildAlert({ severity: 'critical' }));
      expect(sgMail.send).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledTimes(1); // slack recebeu mesmo com email quebrado
    });

    it('email DESLIGADO (sem SEND_GRID): ignora silenciosamente, não chama sgMail.send', async () => {
      const config = makeConfig({ SEND_GRID: undefined });
      const service = new SecurityAlertsService(config, makeEventEmitter());
      silenceLogger(service);
      await service.onModuleInit();
      await service.handleSecurityAlert(buildAlert({ severity: 'critical' }));
      expect(sgMail.send).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 9) Gerência de canais (utilitários)
  // ==========================================================================
  describe('gerência de canais — add/remove/toggle/stats/testChannel', () => {
    it('addChannel adiciona novo e recusa id duplicado', async () => {
      const { service } = await bootstrap();
      const novo = {
        id: 'extra',
        type: 'webhook' as const,
        enabled: true,
        config: { url: 'https://x.test' },
        rules: [],
      };
      expect(service.addChannel(novo)).toBe(true);
      expect(service.addChannel(novo)).toBe(false); // duplicado
      expect(service.getChannels().some((c) => c.id === 'extra')).toBe(true);
    });

    it('removeChannel remove existente e devolve false para inexistente', async () => {
      const { service } = await bootstrap();
      expect(service.removeChannel('email-admin')).toBe(true);
      expect(service.removeChannel('nao-existe')).toBe(false);
    });

    it('toggleChannel liga/desliga; inexistente devolve false', async () => {
      const { service } = await bootstrap();
      expect(service.toggleChannel('email-admin', false)).toBe(true);
      expect(service.getChannels().find((c) => c.id === 'email-admin')!.enabled).toBe(false);
      expect(service.toggleChannel('fantasma', true)).toBe(false);
    });

    it('getAlertStats conta canais por tipo e regras por severidade', async () => {
      const { service } = await bootstrap({ SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' });
      const stats = service.getAlertStats();
      expect(stats.totalChannels).toBe(2);
      expect(stats.enabledChannels).toBe(2);
      expect(stats.channelsByType.email).toBe(1);
      expect(stats.channelsByType.slack).toBe(1);
      // email tem regras high+critical; slack tem regra low
      expect(stats.rulesBySeverity.high).toBe(1);
      expect(stats.rulesBySeverity.critical).toBe(1);
      expect(stats.rulesBySeverity.low).toBe(1);
    });

    it('testChannel envia um alerta de teste e devolve true; canal inexistente devolve false', async () => {
      const { service } = await bootstrap({ SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' });
      await expect(service.testChannel('slack-security')).resolves.toBe(true);
      expect(axios.post).toHaveBeenCalledTimes(1);
      await expect(service.testChannel('nao-existe')).resolves.toBe(false);
    });

    it('testChannel devolve false se o envio do canal falha', async () => {
      const { service } = await bootstrap({ SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' });
      axios.post.mockRejectedValueOnce(new Error('slack down'));
      await expect(service.testChannel('slack-security')).resolves.toBe(false);
    });
  });
});
