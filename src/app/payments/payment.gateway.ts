import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

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

@WebSocketGateway({
  namespace: '/payments',
  cors: {
    origin: WS_ALLOWED_ORIGINS,
    credentials: true,
  },
})
export class PaymentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private readonly server: Server;

  private readonly logger = new Logger(PaymentGateway.name);

  handleConnection(client: Socket) {
    this.logger.debug(`WS client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`WS client disconnected: ${client.id}`);
  }

  @SubscribeMessage('subscribe:order')
  handleSubscribeOrder(
    @MessageBody() data: { orderId: string },
    @ConnectedSocket() client: Socket,
  ) {
    if (!data?.orderId || typeof data.orderId !== 'string') return;
    client.join(`order:${data.orderId}`);
    this.logger.debug(`Client ${client.id} subscribed to order:${data.orderId}`);
  }

  emitPaymentConfirmed(orderId: string): void {
    this.server.to(`order:${orderId}`).emit('payment:confirmed', {
      orderId,
      status: 'PAID',
    });
    this.logger.log(`Emitted payment:confirmed for order ${orderId}`);
  }
}
