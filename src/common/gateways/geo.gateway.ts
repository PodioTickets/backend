import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

// Mesmas origens do PaymentGateway (checkout já usa WS). Mantidas em paralelo
// de propósito (config de infra, não vale acoplar os gateways por causa disso).
const WS_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://app.localhost:3000',
  'http://test890.localhost:3000',
  'https://podioticket.com.br',
  'https://www.podioticket.com.br',
  'https://app.podioticket.com.br',
  'https://test890.podioticket.com.br',
  'https://homologacao.podioticket.com.br',
  'https://homologacao.app.podioticket.com.br',
  'https://homologacao.test890.podioticket.com.br',
];

const GEO_ROOM = 'geo:updates';

/**
 * Notifica os dashboards abertos quando o worker de geocoding resolve um bairro,
 * para o mapa de calor preencher em TEMPO REAL — sem polling. Room global única:
 * a resolução é global (cache compartilhado), e o cliente só entra na room
 * enquanto tiver bairros pendentes (sai quando o mapa fica completo).
 */
@WebSocketGateway({
  namespace: '/geo',
  cors: { origin: WS_ALLOWED_ORIGINS, credentials: true },
})
export class GeoGateway {
  @WebSocketServer()
  private readonly server: Server;

  @SubscribeMessage('subscribe:geo')
  handleSubscribe(@ConnectedSocket() client: Socket) {
    client.join(GEO_ROOM);
  }

  /** Emite que houve progresso de geocoding (o dashboard refaz o fetch). */
  emitGeoResolved(): void {
    this.server?.to(GEO_ROOM).emit('geo:resolved');
  }
}
