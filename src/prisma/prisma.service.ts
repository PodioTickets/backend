import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly readReplica: PrismaClient | null = null;

  constructor(private configService: ConfigService) {
    super({
      log:
        process.env.NODE_ENV === 'development'
          ? ['query', 'error', 'warn']
          : ['error'],
      datasources: {
        db: {
          url: configService.get<string>('DATABASE_URL'),
        },
      },
    });

    // Configurar read replica se disponível
    const readReplicaUrl = configService.get<string>(
      'DATABASE_READ_REPLICA_URL',
    );
    if (readReplicaUrl) {
      this.readReplica = new PrismaClient({
        log: ['error'],
        datasources: {
          db: {
            url: readReplicaUrl,
          },
        },
      });
      this.logger.log('Read replica configured');
    }
  }

  async onModuleInit() {
    await this.$connect();
    if (this.readReplica) {
      await this.readReplica.$connect();
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    if (this.readReplica) {
      await this.readReplica.$disconnect();
    }
  }

  /**
   * Retorna cliente Prisma para operações de leitura
   * Usa read replica se disponível, senão usa a conexão principal
   */
  getReadClient(): PrismaClient {
    return this.readReplica || this;
  }

  /**
   * Retorna cliente Prisma para operações de escrita
   * Sempre usa a conexão principal (master)
   */
  getWriteClient(): PrismaClient {
    return this;
  }

  /**
   * Sincroniza o read replica com o master (apenas em desenvolvimento)
   * Em produção, o read replica é sincronizado automaticamente via streaming replication
   */
  async syncReadReplica(): Promise<void> {
    if (process.env.NODE_ENV === 'production' || !this.readReplica) {
      return; // Em produção, a replicação é automática
    }

    // Em desenvolvimento, não sincronizamos automaticamente após cada escrita
    // pois seria muito custoso. O read replica deve ser sincronizado manualmente
    // usando `pnpm db:sync` ou via streaming replication quando configurado corretamente
    this.logger.debug(
      'Read replica sync skipped in development (manual sync required)',
    );
  }
}
