import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, UserActivityCategory } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Retenção em camadas:
 *  - Categorias de auditoria (AUTH/CHECKOUT/COMPLIANCE): 2 anos (730d).
 *    Justificativa: prova forense de transações financeiras + LGPD
 *    permite retenção pelo prazo necessário ao cumprimento de obrigações
 *    legais (Marco Civil, Código de Defesa do Consumidor).
 *  - Demais (PAGE_VIEW/CLICK/API/PROFILE/OTHER): 90d.
 *    Justificativa: analytics de UX não precisa de histórico longo;
 *    LGPD desestimula retenção além do necessário pra finalidade.
 *
 * Sobrescrever via env:
 *  - USER_ACTIVITY_RETENTION_DAYS_ANALYTICS
 *  - USER_ACTIVITY_RETENTION_DAYS_AUDIT
 */
@Injectable()
export class UserActivityCleanupService {
  private readonly logger = new Logger(UserActivityCleanupService.name);

  private static readonly AUDIT_CATEGORIES: UserActivityCategory[] = [
    UserActivityCategory.AUTH,
    UserActivityCategory.CHECKOUT,
    UserActivityCategory.COMPLIANCE,
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Roda 1× por dia às 03h00 (horário do server). Janela escolhida pra
   * cair fora de pico de tráfego e fora dos crons financeiros existentes
   * (repasse, expiração).
   *
   * Delete em duas queries separadas pra cada bucket de retenção. Postgres
   * resolve em range scan no índice (`occurredAt`) + filtro de categoria
   * — barato mesmo com tabela grande.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runCleanup(): Promise<void> {
    const analyticsDays = this.readDaysEnv(
      'USER_ACTIVITY_RETENTION_DAYS_ANALYTICS',
      90,
    );
    const auditDays = this.readDaysEnv(
      'USER_ACTIVITY_RETENTION_DAYS_AUDIT',
      730,
    );

    const now = Date.now();
    const analyticsCutoff = new Date(now - analyticsDays * 86_400_000);
    const auditCutoff = new Date(now - auditDays * 86_400_000);

    try {
      const prismaWrite = this.prisma.getWriteClient();

      const analyticsDel = await prismaWrite.userActivityLog.deleteMany({
        where: {
          occurredAt: { lt: analyticsCutoff },
          category: {
            notIn: UserActivityCleanupService.AUDIT_CATEGORIES,
          },
        },
      });

      const auditDel = await prismaWrite.userActivityLog.deleteMany({
        where: {
          occurredAt: { lt: auditCutoff },
          category: {
            in: UserActivityCleanupService.AUDIT_CATEGORIES,
          },
        },
      });

      if (analyticsDel.count > 0 || auditDel.count > 0) {
        this.logger.log(
          `UserActivity cleanup: ${analyticsDel.count} analytics (>${analyticsDays}d) + ${auditDel.count} audit (>${auditDays}d) removidos`,
        );
      }
    } catch (err) {
      // Cleanup é fail-open: erro aqui não pode derrubar nada. Loga e
      // tenta de novo no próximo tick (24h depois).
      const message =
        err instanceof Prisma.PrismaClientKnownRequestError
          ? `${err.code}: ${err.message}`
          : (err as Error).message;
      this.logger.error(`UserActivity cleanup falhou: ${message}`);
    }
  }

  private readDaysEnv(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    if (!raw) return fallback;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.logger.warn(
        `${key} inválido ("${raw}"), usando default ${fallback} dias`,
      );
      return fallback;
    }
    return parsed;
  }
}
