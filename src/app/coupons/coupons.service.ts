import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCouponDto, UpdateCouponDto, FilterCouponsDto, CouponStatus } from './dto/create-coupon.dto';
import { buildDocumentList } from '../../common/utils/document.util';
import { computeAgeAt } from '../../common/utils/age.util';
import { brtDayEndUtc } from '../../common/utils/brt-date.util';
import { sumActiveCouponReservations } from '../../common/utils/coupon-reservation.util';

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, eventId: string, createCouponDto: CreateCouponDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    // Validar campos específicos por tipo
    this.validateCouponData(createCouponDto);

    // Cupons AGE não podem ter intervalos sobrepostos no mesmo evento
    if (createCouponDto.couponType === 'AGE') {
      await this.assertNoAgeOverlap(eventId, createCouponDto as any);
    }

    // Verificar se o código já existe para este evento (apenas se fornecido)
    if (createCouponDto.code) {
      const existingCoupon = await prismaWrite.coupon.findUnique({
        where: {
          eventId_code: {
            eventId,
            code: createCouponDto.code.toUpperCase(),
          },
        },
      });

      if (existingCoupon) {
        throw new BadRequestException('Código do cupom já existe para este evento');
      }
    }

    // Converter appliesTo array para JSON string se necessário
    let appliesToValue: string | null = null;
    if (createCouponDto.appliesTo) {
      if (Array.isArray(createCouponDto.appliesTo)) {
        appliesToValue = JSON.stringify(createCouponDto.appliesTo);
      } else {
        appliesToValue = createCouponDto.appliesTo;
      }
    }

    // Converter expiryDate para Date se fornecido
    let expiryDateValue: Date | null = null;
    if (createCouponDto.expiryDate) {
      expiryDateValue = this.parseDate(createCouponDto.expiryDate);
    }

    // Verificar se o cupom está expirado
    let status = CouponStatus.ACTIVE;
    if (expiryDateValue && expiryDateValue < new Date()) {
      status = CouponStatus.EXPIRED;
    }

    // Dual-write: grava documentList (shape novo) e mantém cpfList em
    // paralelo durante a transição. buildDocumentList prefere documentList
    // do DTO e auto-converte cpfList quando só este vem (cliente legado).
    const documentList = buildDocumentList({
      documentList: createCouponDto.documentList,
      cpfList: createCouponDto.cpfList,
    });

    const coupon = await prismaWrite.coupon.create({
      data: {
        ...createCouponDto,
        code: createCouponDto.code ? createCouponDto.code.toUpperCase() : null,
        eventId,
        status,
        expiryDate: expiryDateValue,
        appliesTo: appliesToValue,
        cpfList: createCouponDto.cpfList ? (createCouponDto.cpfList as any) : null,
        documentList: (documentList as any) ?? null,
        cpfListStatus: createCouponDto.cpfListStatus || 'DISABLED',
        minCartValue: createCouponDto.minCartValue != null ? createCouponDto.minCartValue : null,
        maxUsage: createCouponDto.maxUsage ?? null,
      },
    });

    // Converter appliesTo de JSON string para array quando necessário
    const transformedCoupon = {
      ...coupon,
      appliesTo: this.parseAppliesTo(coupon.appliesTo),
    };

    return {
      message: 'Coupon created successfully',
      data: { coupon: transformedCoupon },
    };
  }

  async findAll(eventId: string, filterDto: FilterCouponsDto = {}) {
    const prismaRead = this.prisma.getReadClient();

    const page = filterDto.page || 1;
    const limit = filterDto.limit || 10;
    const skip = (page - 1) * limit;

    // `now` é fonte única para o filtro E para o status efetivo exibido — ambos
    // precisam concordar (cupom ATIVO vencido = EXPIRED nos dois lados).
    const now = new Date();

    const where: any = { eventId, deletedAt: null };
    // Filtro por status EFETIVO (não o cru do banco): como não há cron que vire
    // ACTIVE→EXPIRED, traduzimos o status pedido em condições de validade — assim
    // a lista, a contagem e a paginação ficam consistentes com a badge exibida.
    if (filterDto.status === CouponStatus.ACTIVE) {
      // Efetivamente ativo = ATIVO no banco E ainda não vencido.
      where.status = CouponStatus.ACTIVE;
      where.OR = [{ expiryDate: null }, { expiryDate: { gte: now } }];
    } else if (filterDto.status === CouponStatus.EXPIRED) {
      // Efetivamente expirado = EXPIRED no banco OU ATIVO com validade vencida.
      where.OR = [
        { status: CouponStatus.EXPIRED },
        { status: CouponStatus.ACTIVE, expiryDate: { lt: now } },
      ];
    } else if (filterDto.status) {
      // INACTIVE (ou outro) → status cru; INACTIVE é preservado (desligado manual).
      where.status = filterDto.status;
    }

    const [coupons, total] = await Promise.all([
      prismaRead.coupon.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prismaRead.coupon.count({ where }),
    ]);

    // Converter appliesTo de JSON string para array quando necessário + status EFETIVO.
    // Espelha o filtro acima: cupom ATIVO com validade vencida → EXPIRED na badge
    // (não há cron que vire o status). INACTIVE (desligado manual) é preservado.
    // Mesma lista serve organizador e admin.
    const transformedCoupons = coupons.map((coupon) => ({
      ...coupon,
      appliesTo: this.parseAppliesTo(coupon.appliesTo),
      status:
        coupon.status === CouponStatus.ACTIVE &&
        coupon.expiryDate &&
        coupon.expiryDate < now
          ? CouponStatus.EXPIRED
          : coupon.status,
    }));

    const totalPages = Math.ceil(total / limit);

    return {
      message: 'Coupons fetched successfully',
      data: {
        coupons: transformedCoupons,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      },
    };
  }

  async findOne(id: string) {
    const prismaRead = this.prisma.getReadClient();
    const coupon = await prismaRead.coupon.findUnique({
      where: { id },
      include: {
        event: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!coupon) {
      throw new NotFoundException('Cupom não encontrado');
    }

    // Converter appliesTo de JSON string para array quando necessário
    const transformedCoupon = {
      ...coupon,
      appliesTo: this.parseAppliesTo(coupon.appliesTo),
    };

    return {
      message: 'Coupon fetched successfully',
      data: { coupon: transformedCoupon },
    };
  }

  /**
   * Preview público de cupom OU voucher pelo código. Usado pelo checkout
   * antes de aplicar — o front tem um único input de "código de desconto",
   * então a rota resolve os dois tipos e devolve um `kind` discriminador
   * (`'coupon'` | `'voucher'`).
   *
   * Retorna o que o front precisa pra exibir a sinalização ("R$ 50 OFF",
   * "10% OFF", "ingresso grátis") + as CONDIÇÕES/escopo de aplicação:
   *   - appliesTo: ingressos cobertos ('all' ou lista de ticketIds — públicos)
   *   - minCartValue: valor mínimo do carrinho (centavos)
   *   - minQuantity: qtd mínima de ingressos (cupons QUANTITY)
   * Continua SEM vazar:
   *   - cpfList/documentList (PII de elegíveis)
   *   - usageCount/maxUsage (timing pra esgotar cupom)
   *   - ageRule/minAge/maxAge (AGE não entra aqui), note (texto interno do organizador)
   *
   * Precedência voucher > cupom: espelha `OrdersService.patchCoupon`, onde um
   * voucher ACTIVE e não-expirado tem prioridade sobre um cupom de mesmo
   * código. Garante que "validar" (preview) e "aplicar" (checkout) nunca
   * divirjam — se o checkout vai aplicar o voucher, o preview também o anuncia.
   *
   * NUNCA lança: sempre `{ data: preview | null }` com HTTP 200 (anônimo via
   * OptionalJwtAuthGuard no controller — nunca 401). Código ausente/inválido/
   * inexistente/expirado/inativo/voucher-usado → `data: null`. AGE NÃO entra
   * aqui (tem o endpoint `age-eligibility`, que depende do usuário). Preview é
   * SÓ exibição: NÃO valida CPF / limite de uso / valor mínimo — isso fica pro
   * apply/pay quando o usuário já está logado.
   *
   * Performance: cupom e voucher são buscados em paralelo com o evento
   * (Promise.all) — ambos por unique key `(eventId, code)`, point-lookups
   * indexados. O lookup extra do voucher não adiciona latência (corre em
   * paralelo) e o custo de DB é desprezível.
   *
   * Segurança: rota pública. Rate-limit é aplicado no controller via
   * `@Throttle` (preview é alvo natural pra brute-force de códigos).
   * Code é uppercased antes do lookup pra match case-insensitive.
   */
  async previewByCode(eventId: string, rawCode: string | undefined) {
    // SOMENTE exibição (link do checkout, anônimo). NUNCA lança / NUNCA 401/404/422:
    // devolve sempre `{ data: preview | null }` com HTTP 200. Código ausente/inválido/
    // inexistente/expirado/inativo → `data: null` (front trata como "sem preview").
    const code = (rawCode ?? '').trim().toUpperCase();
    if (!eventId || !code) return { data: null };

    const prismaRead = this.prisma.getReadClient();

    const [event, coupon, voucher] = await Promise.all([
      prismaRead.event.findUnique({ where: { id: eventId }, select: { id: true } }),
      prismaRead.coupon.findUnique({
        where: { eventId_code: { eventId, code } },
        select: {
          id: true, // p/ somar as reservas ativas (pedidos PENDING) no esgotamento
          code: true,
          value: true,
          type: true,
          couponType: true,
          applyToProducts: true,
          appliesTo: true, // ingressos cobertos ('all' ou lista de ticketIds)
          minCartValue: true, // condição: valor mínimo do carrinho (centavos)
          minQuantity: true, // condição: qtd mínima de ingressos (cupons QUANTITY)
          maxUsage: true, // limite de uso (null = ilimitado) — esconde cupom esgotado do link
          usageCount: true, // usos já consumidos (só p/ checar esgotamento; NÃO exposto)
          status: true,
          expiryDate: true,
          deletedAt: true,
        },
      }),
      prismaRead.voucher.findUnique({
        where: { eventId_code: { eventId, code } },
        select: {
          code: true,
          appliesTo: true,
          status: true,
          expiryDate: true,
          usedAt: true,
          deletedAt: true,
          // Reserva por pedido ATIVO: enquanto um carrinho PENDING detém o voucher,
          // ele fica indisponível para outros compradores → some do preview.
          reservedByOrderId: true,
          reservedUntil: true,
        },
      }),
    ]);

    if (!event) return { data: null };

    // Confia na data E no status (cron de expiração pode não ter rodado / expiração manual).
    const now = new Date();

    // 1) Voucher usável → prioridade sobre cupom (espelha o checkout). Usado/expirado/
    //    inativo/soft-deleted → ignora (cai pro cupom ou null).
    // Reservado por um pedido ATIVO (outro carrinho PENDING o detém): indisponível
    // até a reserva expirar/ser liberada. `reservedUntil < now` = reserva vencida
    // (carrinho abandonado) → tratado como livre. Voucher = 1 unidade: reservado por
    // QUALQUER pedido já esgota para os demais.
    const voucherReserved =
      !!voucher?.reservedByOrderId &&
      (!voucher.reservedUntil || voucher.reservedUntil >= now);
    const voucherUsable =
      !!voucher &&
      !voucher.deletedAt &&
      voucher.status === 'ACTIVE' &&
      !voucher.usedAt &&
      !voucherReserved &&
      (!voucher.expiryDate || voucher.expiryDate >= now);
    if (voucherUsable) {
      return {
        data: {
          kind: 'voucher' as const,
          code: voucher!.code,
          // Normaliza pro shape ideal (array quando há lista de ingressos); 'all' quando irrestrito.
          appliesTo: this.parseAppliesTo(voucher!.appliesTo) ?? 'all',
        },
      };
    }

    // 2) Cupom EXIBÍVEL: DISCOUNT/QUANTITY (AGE tem endpoint próprio — age-eligibility — e
    //    depende do usuário, então fica FORA do preview do link). Preview é só exibição:
    //    NÃO rejeita por CPF/valor mínimo (validação real no apply/pay). Esconde o que jamais
    //    poderia aplicar: inexistente, soft-deleted, expirado (data/status), inativo OU ESGOTADO
    //    (usageCount >= maxUsage). Esgotamento espelha o `COUPON_EXHAUSTED` do patchCoupon/pay e
    //    o filtro do cupom AGE — sem isso o link mostrava "10% OFF" num cupom que o apply rejeita.
    // Esgotamento considera VENDAS (usageCount) + RESERVAS ATIVAS (couponReservedUnits
    // dos pedidos PENDING não-expirados). Ex.: limite 10, 9 vendidos e 1 reservado por
    // um carrinho ativo → 10/10 → esgotado p/ os demais. Lê do PRIMÁRIO p/ refletir a
    // reserva recém-feita sem lag de réplica. Só consulta quando há limite (maxUsage).
    const couponActiveReserved =
      coupon && coupon.maxUsage != null
        ? await sumActiveCouponReservations(this.prisma.getWriteClient(), coupon.id)
        : 0;
    const couponExhausted =
      !!coupon &&
      coupon.maxUsage != null &&
      coupon.usageCount + couponActiveReserved >= coupon.maxUsage;
    const couponDisplayable =
      !!coupon &&
      !coupon.deletedAt &&
      coupon.couponType !== 'AGE' &&
      coupon.status !== 'EXPIRED' &&
      coupon.status !== 'INACTIVE' &&
      !couponExhausted &&
      (!coupon.expiryDate || coupon.expiryDate >= now);
    if (couponDisplayable) {
      return {
        data: {
          kind: 'coupon' as const,
          code: coupon!.code,
          couponType: coupon!.couponType,
          type: coupon!.type,
          value: coupon!.value, // PERCENTAGE: 1–100 | FIXED: centavos
          applyToProducts: coupon!.applyToProducts,
          // Ingressos cobertos: normaliza pro shape ideal (array de ticketIds) ou 'all' quando
          // irrestrito — espelha o ramo do voucher acima. O front mapeia os ids pros nomes (lista
          // de ingressos já é pública). NÃO expõe PII (cpf/document), uso (usageCount) nem `note`.
          appliesTo: this.parseAppliesTo(coupon!.appliesTo) ?? 'all',
          // Condições de aplicação (exibição na UX). null/ausente = sem condição — o
          // ResponseCompressionInterceptor remove chaves null do response.
          minCartValue: coupon!.minCartValue, // centavos
          minQuantity: coupon!.minQuantity, // cupons QUANTITY
          // Uso RESTANTE (maxUsage − usageCount) — só p/ DISCOUNT (1 uso = 1 unidade
          // coberta), pra o front capar o desconto do preview às N unidades mais caras.
          // QUANTITY é all-or-nothing por PEDIDO (não por unidade) → não envia (null).
          // Sem maxUsage → null (sem limite). Esgotado já foi filtrado em couponDisplayable.
          remaining:
            coupon!.couponType === 'DISCOUNT' && coupon!.maxUsage != null
              ? Math.max(0, coupon!.maxUsage - coupon!.usageCount - couponActiveReserved)
              : null,
        },
      };
    }

    // 3) Nada exibível (inexistente / expirado / inativo / voucher usado / AGE) → null (HTTP 200).
    return { data: null };
  }

  /**
   * Cupom AGE (por faixa etária) que será aplicado ao usuário se ele prosseguir
   * para o pagamento ao entrar num evento.
   *
   * A idade é calculada na DATA DO EVENTO (mesma regra do checkout — ver
   * `computeAgeAt`), não na data atual: um usuário que completa a idade-alvo
   * antes do evento já qualifica. Reutiliza a mesma função de idade do
   * `orders.service` para garantir que elegibilidade e aplicação nunca divirjam.
   *
   * **Resultado é único** (`appliedCoupon`, não lista): `assertNoAgeOverlap`
   * impede faixas etárias sobrepostas entre os cupons AGE de um evento, então
   * uma dada idade casa com no máximo UM cupom AGE — exatamente o que o checkout
   * auto-aplicaria. Quando, por dado legado, houver sobreposição, escolhemos
   * de forma determinística o de menor `minAge` (`orderBy`).
   *
   * Elegibilidade (espelha a auto-aplicação do checkout para AGE):
   *   - evento existe;
   *   - cupom ACTIVE, não soft-deletado, não expirado;
   *   - idade ∈ [minAge ?? 0, maxAge ?? ∞];
   *   - cupom não esgotado: usageCount + reservas ATIVAS (pedidos PENDING) < maxUsage.
   *
   * `minCartValue` e `appliesTo` são RETORNADOS no cupom (para a UX exibir as
   * CONDIÇÕES da aplicação final), mas NÃO filtram aqui — não há carrinho nesta
   * etapa; o checkout valida modalidade e valor mínimo no momento da compra.
   *
   * Não vaza contadores de uso, listas de elegíveis (cpf/document) nem regras
   * internas.
   *
   * @param user perfil autenticado (de `req.user`) ou `null` (anônimo).
   */
  async getApplicableAgeCoupons(
    eventId: string,
    user: { dateOfBirth?: Date | string | null } | null,
  ) {
    const prismaRead = this.prisma.getReadClient();

    const event = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { id: true, eventDate: true },
    });
    if (!event) {
      throw new NotFoundException({
        code: 'EVENT_NOT_FOUND',
        message: 'Evento não encontrado',
      });
    }

    // Sem usuário ou sem data de nascimento não há idade a avaliar.
    const birthDate = user?.dateOfBirth ?? null;
    if (!birthDate) {
      return {
        message: 'Age coupon eligibility evaluated',
        data: {
          applicable: false,
          reason: user ? 'NO_BIRTHDATE' : 'NOT_AUTHENTICATED',
          age: null,
          appliedCoupon: null,
        },
      };
    }

    // Idade na data do evento (fonte de verdade); fallback "agora" se o evento
    // não tiver data definida — alinhado com `resolveAgeReferenceDate` do checkout.
    const referenceDate = event.eventDate ? new Date(event.eventDate) : new Date();
    const age = computeAgeAt(birthDate, referenceDate);

    const now = new Date();
    // Filtro coberto pelo índice @@index([eventId, status]).
    const ageCoupons = await prismaRead.coupon.findMany({
      where: {
        eventId,
        couponType: 'AGE',
        status: 'ACTIVE',
        deletedAt: null,
        OR: [{ expiryDate: null }, { expiryDate: { gt: now } }],
      },
      select: {
        id: true,
        code: true,
        couponType: true,
        type: true,
        value: true,
        ageRule: true,
        ageValue: true,
        minAge: true,
        maxAge: true,
        appliesTo: true,
        applyToProducts: true,
        minCartValue: true,
        note: true,
        usageCount: true,
        maxUsage: true,
      },
      // minAge asc → desempate determinístico caso (dado legado) haja sobreposição.
      orderBy: { minAge: 'asc' },
    });

    // Candidatos pela FAIXA ETÁRIA (invariante de não-sobreposição → normalmente
    // 0 ou 1; ordenados por minAge asc p/ desempate determinístico em dado legado).
    const ageMatches = ageCoupons.filter((c) => {
      const min = c.minAge ?? 0;
      const max = c.maxAge ?? Number.POSITIVE_INFINITY;
      return age >= min && age <= max;
    });

    // Esgotamento considera VENDAS (usageCount) + RESERVAS ATIVAS (pedidos PENDING) —
    // mesma regra do preview de link. AGE auto-aplicado reserva 1 unidade no PENDING,
    // então um carrinho ativo que segurou o último uso esconde o preview p/ os demais.
    // Pula esgotados e pega o 1º disponível (preserva o caso legado de sobreposição);
    // só consulta reservas para candidatos COM limite (poucos/zero candidatos).
    let winner: (typeof ageCoupons)[number] | undefined;
    for (const c of ageMatches) {
      if (c.maxUsage == null) {
        winner = c; // sem limite → sempre disponível
        break;
      }
      const reserved = await sumActiveCouponReservations(
        this.prisma.getWriteClient(),
        c.id,
      );
      if (c.usageCount + reserved < c.maxUsage) {
        winner = c;
        break;
      }
    }

    return {
      message: 'Age coupon eligibility evaluated',
      data: {
        applicable: !!winner,
        age,
        eventDate: event.eventDate,
        // O cupom que o checkout aplicará se o usuário prosseguir. `appliesTo` e
        // `minCartValue` são as CONDIÇÕES dessa aplicação (avaliadas no checkout).
        appliedCoupon: winner
          ? {
              id: winner.id,
              code: winner.code,
              couponType: winner.couponType,
              type: winner.type, // PERCENTAGE | FIXED
              value: winner.value, // % inteiro (PERCENTAGE) ou centavos (FIXED)
              ageRule: winner.ageRule,
              ageValue: winner.ageValue,
              minAge: winner.minAge,
              maxAge: winner.maxAge,
              appliesTo: winner.appliesTo ?? 'all',
              applyToProducts: winner.applyToProducts,
              minCartValue: winner.minCartValue,
              note: winner.note,
            }
          : null,
      },
    };
  }

  async update(userId: string, eventId: string, couponId: string, updateCouponDto: UpdateCouponDto) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const coupon = await prismaWrite.coupon.findUnique({
      where: { id: couponId },
    });

    if (!coupon || coupon.eventId !== eventId) {
      throw new NotFoundException('Cupom não encontrado');
    }

    // Limite não pode ser menor que o uso atual
    if (updateCouponDto.maxUsage != null && updateCouponDto.maxUsage < coupon.usageCount) {
      throw new BadRequestException(
        `O limite não pode ser menor que o uso atual (${coupon.usageCount})`,
      );
    }

    // Se o código está sendo atualizado, verificar se já existe
    if (updateCouponDto.code) {
      const existingCoupon = await prismaWrite.coupon.findUnique({
        where: {
          eventId_code: {
            eventId,
            code: updateCouponDto.code.toUpperCase(),
          },
        },
      });

      if (existingCoupon && existingCoupon.id !== couponId) {
        throw new BadRequestException('Código do cupom já existe para este evento');
      }
    }

    // Validar campos específicos por tipo
    if (updateCouponDto.couponType || updateCouponDto.type || updateCouponDto.value) {
      const mergedData = { ...coupon, ...updateCouponDto };
      this.validateCouponData(mergedData as any);
    }

    // Cupons AGE: verificar sobreposição de faixa etária (excluindo o próprio cupom)
    const effectiveType = updateCouponDto.couponType ?? coupon.couponType;
    if (effectiveType === 'AGE') {
      const merged = { ...coupon, ...updateCouponDto };
      await this.assertNoAgeOverlap(eventId, merged as any, couponId);
    }

    const updateData: any = { ...updateCouponDto };
    if (updateCouponDto.code) {
      updateData.code = updateCouponDto.code.toUpperCase();
    }
    if (updateCouponDto.appliesTo !== undefined) {
      if (Array.isArray(updateCouponDto.appliesTo)) {
        updateData.appliesTo = JSON.stringify(updateCouponDto.appliesTo);
      } else {
        updateData.appliesTo = updateCouponDto.appliesTo;
      }
    }
    // Update da lista de documentos: aceita documentList (novo) e/ou
    // cpfList (legacy). Quando qualquer um dos dois é informado, recalcula
    // o documentList canônico mantendo cpfList em paralelo.
    // IMPORTANTE: a canônica é derivada APENAS do que veio no update — nunca do
    // documentList VELHO do banco (update só-de-cpfList mantinha a canônica
    // antiga e a elegibilidade validava contra a lista errada — ver Voucher.update).
    if (updateCouponDto.cpfList !== undefined || updateCouponDto.documentList !== undefined) {
      const merged = buildDocumentList({
        documentList: updateCouponDto.documentList ?? null,
        cpfList: updateCouponDto.cpfList ?? null,
      });
      updateData.documentList = (merged as any) ?? null;
      if (updateCouponDto.cpfList !== undefined) {
        updateData.cpfList = updateCouponDto.cpfList as any;
      }
    } else {
      // Sem mudança em listas — não persistir o `documentList` cru do spread
      // (ele já entrou via `{ ...updateCouponDto }` se o cliente mandou).
      delete updateData.documentList;
    }

    // Converter expiryDate para Date se fornecido
    if (updateCouponDto.expiryDate !== undefined) {
      updateData.expiryDate = updateCouponDto.expiryDate ? this.parseDate(updateCouponDto.expiryDate) : null;
    }

    // Atualizar status se necessário
    let status = updateCouponDto.status || coupon.status;
    if (updateData.expiryDate !== undefined) {
      const expiryDate = updateData.expiryDate || coupon.expiryDate;
      if (expiryDate && expiryDate < new Date()) {
        status = CouponStatus.EXPIRED;
      }
    }
    updateData.status = status;

    const updatedCoupon = await prismaWrite.coupon.update({
      where: { id: couponId },
      data: updateData,
    });

    // Converter appliesTo de JSON string para array quando necessário
    const transformedCoupon = {
      ...updatedCoupon,
      appliesTo: this.parseAppliesTo(updatedCoupon.appliesTo),
    };

    return {
      message: 'Coupon updated successfully',
      data: { coupon: transformedCoupon },
    };
  }

  async remove(userId: string, eventId: string, couponId: string) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();

    const coupon = await prismaWrite.coupon.findUnique({
      where: { id: couponId },
    });

    if (!coupon || coupon.eventId !== eventId) {
      throw new NotFoundException('Cupom não encontrado');
    }

    if (coupon.usageCount > 0) {
      await prismaWrite.coupon.update({
        where: { id: couponId },
        data: { deletedAt: new Date() },
      });
    } else {
      await prismaWrite.coupon.delete({
        where: { id: couponId },
      });
    }

    return {
      message: 'Coupon deleted successfully',
    };
  }

  private async assertNoAgeOverlap(
    eventId: string,
    dto: { minAge?: number | null; maxAge?: number | null },
    excludeId?: string,
  ): Promise<void> {
    const prismaRead = this.prisma.getReadClient();
    const newMin = dto.minAge ?? 0;
    const newMax = dto.maxAge ?? Infinity;

    const existingAge = await prismaRead.coupon.findMany({
      where: {
        eventId,
        couponType: 'AGE',
        deletedAt: null,
        status: { not: 'EXPIRED' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true, minAge: true, maxAge: true },
    });

    for (const existing of existingAge) {
      const eMin = existing.minAge ?? 0;
      const eMax = existing.maxAge ?? Infinity;
      // Duas faixas se sobrepõem quando: newMin <= eMax E newMax >= eMin
      if (newMin <= eMax && newMax >= eMin) {
        const eMaxLabel = existing.maxAge != null ? String(existing.maxAge) : '∞';
        const newMaxLabel = dto.maxAge != null ? String(dto.maxAge) : '∞';
        throw new BadRequestException(
          `Faixa etária ${newMin}–${newMaxLabel} anos sobrepõe o cupom existente ${eMin}–${eMaxLabel} anos`,
        );
      }
    }
  }

  private validateCouponData(dto: CreateCouponDto | UpdateCouponDto) {
    // Validar código obrigatório para DISCOUNT
    if (dto.couponType === 'DISCOUNT' && !dto.code) {
      throw new BadRequestException('code is required for DISCOUNT coupon type');
    }

    // Validar valor máximo para PERCENTAGE
    if (dto.type === 'PERCENTAGE' && dto.value && dto.value > 100) {
      throw new BadRequestException('Valor percentual não pode exceder 100');
    }

    // Validar campos obrigatórios para QUANTITY
    if (dto.couponType === 'QUANTITY') {
      if (!dto.minQuantity || dto.minQuantity <= 0) {
        throw new BadRequestException('minQuantity is required and must be greater than 0 for QUANTITY coupon type');
      }
    }

    // Validar campos obrigatórios para AGE — requer minAge ou maxAge (ou ageRule/ageValue legado)
    if (dto.couponType === 'AGE') {
      const hasNewFields = (dto as any).minAge != null || (dto as any).maxAge != null;
      const hasLegacyFields = dto.ageRule && dto.ageValue;
      if (!hasNewFields && !hasLegacyFields) {
        throw new BadRequestException('AGE coupon requires minAge/maxAge or ageRule/ageValue');
      }
    }

    // Validar lista de documentos quando habilitada: aceita cpfList (legacy)
    // OU documentList (novo, internacionalizado). Pelo menos um precisa
    // estar preenchido.
    if (dto.cpfListStatus === 'ENABLED') {
      const hasCpf = Array.isArray(dto.cpfList) && dto.cpfList.length > 0;
      const hasDocList = Array.isArray((dto as any).documentList) && (dto as any).documentList.length > 0;
      if (!hasCpf && !hasDocList) {
        throw new BadRequestException('documentList ou cpfList é obrigatório quando cpfListStatus = ENABLED');
      }
    }
  }

  private parseDate(dateString: string): Date {
    // Dia civil (YYYY-MM-DD) escolhido pelo organizador → FIM do dia em BRT
    // (America/Sao_Paulo, UTC-3 fixo). Usar fim do dia em UTC (T23:59:59Z) fazia
    // o cupom/voucher expirar às 20:59 BRT — 3h cedo — rejeitando compras feitas
    // ainda no mesmo dia no Brasil (ex.: 22h BRT). brtDayEndUtc resolve a fronteira
    // como (dia+1)T02:59:59.999Z, que é 23:59:59.999 BRT do dia escolhido.
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      return brtDayEndUtc(dateString);
    }

    // Caso contrário, tentar fazer parse direto
    return new Date(dateString);
  }

  private parseAppliesTo(appliesTo: string | null): string | string[] | null {
    if (!appliesTo) {
      return null;
    }
    // Tentar fazer parse do JSON, se falhar retorna a string original
    try {
      const parsed = JSON.parse(appliesTo);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      return appliesTo;
    } catch {
      return appliesTo;
    }
  }

  private async verifyOrganizerAccess(userId: string, eventId: string) {
    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    // Admin/staff bypassa checagens de organização
    const user = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (user?.role === 'ADMIN' || user?.role === 'PODIOGO_STAFF') return;

    const event = await prismaRead.event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    // Verificar se o usuário é membro da organização do evento
    const member = await prismaRead.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: event.organizationId,
          userId,
        },
      },
    });

    if (!member) {
      throw new BadRequestException('Usuário não é membro da organização deste evento');
    }
  }
}
