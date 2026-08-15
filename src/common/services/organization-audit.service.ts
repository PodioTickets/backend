import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Serviço ENXUTO de trilha de auditoria do organizador.
 *
 * Sink único para gravar em `OrganizationAuditLog` — TODA ação de escrita que um
 * organizador/colaborador executa na plataforma (cupons, vouchers, perguntas,
 * tópicos, notificações, kits, ingressos, produtos, evento, organização, …) deve
 * passar por aqui, para que o painel de auditoria (organizador + admin) mostre
 * "quem fez o quê, quando e de onde".
 *
 * Vive no `CommonModule` (já importado por todos os domínios) e depende SÓ do
 * PrismaService — de propósito. Assim qualquer service de domínio injeta este
 * serviço leve sem puxar o `OrganizationsService` inteiro (MFA/e-mail/etc.) nem
 * arriscar dependência circular. O `OrganizationsService` delega a ele para
 * preservar a API pública histórica (`recordOrganizationAuditLog`).
 */
@Injectable()
export class OrganizationAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Grava uma entrada de auditoria. `action` = texto curto legível; `metadata`
   * classifica (`kind`) e carrega o diff (`changes`/`fieldsEdited`) quando houver.
   *
   * Best-effort por padrão: auditar NUNCA deve derrubar a operação de negócio
   * (o log é um efeito colateral). Falhas são engolidas e logadas — exceto
   * dentro de transações, onde o caller passa um `tx` e assume a semântica dele.
   */
  async record(params: {
    organizationId: string;
    actorUserId: string | null;
    ip?: string | null;
    action: string;
    metadata?: Prisma.InputJsonValue;
    /** Client transacional opcional: grava o log DENTRO da tx do caller. */
    tx?: Prisma.TransactionClient;
  }): Promise<void> {
    const client = params.tx ?? this.prisma.getWriteClient();
    const data = {
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      ip: params.ip ?? null,
      action: params.action,
      metadata:
        params.metadata === undefined
          ? Prisma.JsonNull
          : this.prepareAuditMetadata(params.metadata),
    };

    // Dentro de tx: propaga o erro (o caller decide o rollback). Fora de tx:
    // best-effort — a auditoria não pode inviabilizar a ação já concluída.
    if (params.tx) {
      await client.organizationAuditLog.create({ data });
      return;
    }
    try {
      await client.organizationAuditLog.create({ data });
    } catch {
      // Silencioso de propósito: sem stack de logger aqui para não acoplar; o
      // caller de negócio segue normalmente mesmo se a auditoria falhar.
    }
  }

  /**
   * Açúcar para ações EVENT-SCOPED (cupom, voucher, pergunta, tópico, kit,
   * categoria, notificação, …): resolve `event → organizationId + name` num
   * único ponto e grava o log. `action` recebe o NOME do evento para compor o
   * texto legível. `kind` + `extra` vão no metadata (junto de `eventId`).
   *
   * Best-effort: evento inexistente → no-op silencioso (nunca derruba a ação).
   */
  async recordForEvent(
    eventId: string,
    params: {
      actorUserId: string | null;
      ip?: string | null;
      kind: string;
      action: (eventName: string) => string;
      extra?: Record<string, unknown>;
      tx?: Prisma.TransactionClient;
    },
  ): Promise<void> {
    const client = params.tx ?? this.prisma.getReadClient();
    const event = await client.event.findUnique({
      where: { id: eventId },
      select: { organizationId: true, name: true },
    });
    if (!event) return;
    await this.record({
      organizationId: event.organizationId,
      actorUserId: params.actorUserId,
      ip: params.ip ?? null,
      action: params.action(event.name),
      metadata: {
        kind: params.kind,
        eventId,
        ...(params.extra ?? {}),
      } as Prisma.InputJsonValue,
      tx: params.tx,
    });
  }

  /**
   * Normaliza o metadata de auditoria: serializa Date/bigint/objetos e duplica
   * `old/new` em `valorAnterior/valorNovo` (compat com o front pt-BR que já lê
   * essas chaves). Mantém o MESMO shape gravado historicamente.
   */
  private prepareAuditMetadata(
    meta: Prisma.InputJsonValue,
  ): Prisma.InputJsonValue {
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
      return this.serializeAuditValue(meta) as Prisma.InputJsonValue;
    }
    const base = meta as Record<string, unknown>;
    const out: Record<string, unknown> = { ...base };
    if (Array.isArray(out.changes)) {
      out.changes = out.changes.map((entry: unknown) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return this.serializeAuditValue(entry);
        }
        const e = entry as Record<string, unknown>;
        const oldS = this.serializeAuditValue(e.old);
        const newS = this.serializeAuditValue(e.new);
        const row: Record<string, unknown> = {
          field: e.field,
          old: oldS,
          new: newS,
          valorAnterior: oldS,
          valorNovo: newS,
        };
        if ('label' in e && e.label !== undefined) {
          row.label = this.serializeAuditValue(e.label);
        }
        return row;
      });
    }
    for (const key of Object.keys(out)) {
      if (key === 'changes') continue;
      out[key] = this.serializeAuditValue(out[key]);
    }
    return out as Prisma.InputJsonValue;
  }

  private serializeAuditValue(value: unknown): unknown {
    if (value === undefined) return null;
    if (value === null) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) {
      return value.map((v) => this.serializeAuditValue(v));
    }
    if (typeof value === 'object') {
      const o = value as Record<string, unknown> & { toJSON?: () => unknown };
      if (typeof o.toJSON === 'function') {
        return this.serializeAuditValue(o.toJSON());
      }
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) {
        out[k] = this.serializeAuditValue(val);
      }
      return out;
    }
    return value;
  }
}
