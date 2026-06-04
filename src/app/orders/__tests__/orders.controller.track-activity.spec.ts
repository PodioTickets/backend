/**
 * ROTEIRO — funil de checkout 100% contabilizado (@TrackActivity)
 * ================================================================
 * Cada ETAPA do checkout precisa gerar um registro em UserActivityLog
 * (categoria CHECKOUT) — é daí que saem as métricas de funil/drop-off.
 * Este teste lê a METADATA das rotas do OrdersController e trava:
 *
 *  • Etapas rastreadas (mutações do funil + entrada no 3DS):
 *      reserve, participants, participants.remove, products,
 *      billing-address, coupon, pay, 3ds-token
 *  • Fora do funil DE PROPÓSITO (leitura/polling/dev-only):
 *      GET :orderId, GET details, GET payment-status, POST force-expire
 *  • O interceptor está registrado no CONTROLLER (cobre todas as rotas
 *    marcadas; pass-through nas demais).
 *
 * Se alguém remover um decorator sem querer, este teste quebra.
 */
import { OrdersController } from '../orders.controller';
import { TRACK_ACTIVITY_KEY } from '../../../common/decorators/track-activity.decorator';
import { TrackActivityInterceptor } from '../../../common/interceptors/track-activity.interceptor';

const trackMeta = (method: keyof OrdersController) =>
  Reflect.getMetadata(TRACK_ACTIVITY_KEY, OrdersController.prototype[method]);

describe('OrdersController — telemetria do funil de checkout', () => {
  // Etapa → action esperada no UserActivityLog
  const ETAPAS_RASTREADAS: Array<[keyof OrdersController, string]> = [
    ['reserve', 'order.reserve'],
    ['patchParticipants', 'order.participants'],
    ['removeReservedSlot', 'order.participants.remove'],
    ['patchProducts', 'order.products'],
    ['patchBillingAddress', 'order.billing-address'],
    ['patchCoupon', 'order.coupon'],
    ['pay', 'order.pay'],
    ['get3dsToken', 'order.3ds-token'],
  ];

  it.each(ETAPAS_RASTREADAS)(
    '%s é contabilizado como CHECKOUT/%s',
    (method, action) => {
      const meta = trackMeta(method);
      expect(meta).toBeDefined();
      expect(meta.category).toBe('CHECKOUT');
      expect(meta.action).toBe(action);
      // trackErrors NÃO é desligado: etapa que falha (409/422) também conta
      // — essencial pra medir drop-off do funil.
      expect(meta.trackErrors).not.toBe(false);
    },
  );

  it.each([
    ['findOrder'],
    ['getOrderDetails'],
    ['getPaymentStatus'], // polling do PIX — rastrear inundaria o log
    ['forceExpire'], // dev-only
  ] as Array<[keyof OrdersController]>)(
    '%s fica FORA do funil (leitura/polling/dev-only)',
    (method) => {
      expect(trackMeta(method)).toBeUndefined();
    },
  );

  it('o TrackActivityInterceptor está registrado no controller inteiro', () => {
    const interceptors = Reflect.getMetadata('__interceptors__', OrdersController) ?? [];
    expect(interceptors).toContain(TrackActivityInterceptor);
  });
});
