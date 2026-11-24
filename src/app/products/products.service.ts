import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto, FilterProductsDto, ProductVariationDto } from './dto/create-product.dto';
import { OrganizationsService } from '../organizations/organizations.service';
import { UploadService } from '../upload/upload.service';
import { stripDeletedProductFromKitSelectionDisplay } from '../events/kit-selection-display.prune';
import { Prisma, VoucherStatus } from '@prisma/client';
import {
  summarizeProductUpdateForAudit,
  type ProductBeforeAudit,
  type ProductVariationAuditSnapshot,
} from './product-audit.helpers';
import { DEFAULT_NO_INTEREST_VARIATION_NAME, PRODUCT_VARIATIONS_INCLUDE } from './product.constants';
import type { ProductVariationGroupDto } from './dto/create-product.dto';
import { isNoInterestVariation } from '../../common/utils/product-variation.util';

/** Grupo normalizado (trim) pronto p/ sincronizar. */
type NormalizedVariationGroup = {
  id?: string;
  name: string;
  variations: { id?: string; name: string; price?: number; stock?: number }[];
};

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizationsService: OrganizationsService,
    private readonly uploadService: UploadService,
  ) {}

  /**
   * Processa um array de imagens:
   * - Data URLs (data:image/...;base64,...) são enviadas ao UploadService e substituídas pela URL resultante.
   * - URLs já existentes (/uploads/... ou http...) são mantidas intactas.
   */
  private async processImagesArray(images: string[]): Promise<string[]> {
    return Promise.all(
      images.map(async (img) => {
        if (!img.startsWith('data:')) return img;
        const matches = img.match(/^data:([a-zA-Z0-9+/]+\/[a-zA-Z0-9+/]+);base64,(.+)$/);
        if (!matches) {
          throw new BadRequestException('Formato de data URL inválido em images');
        }
        const mimeType = matches[1];
        const base64Data = matches[2];
        const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg';
        const buffer = Buffer.from(base64Data, 'base64');
        return this.uploadService.compressImage({
          buffer,
          originalname: `product-image.${ext}`,
        });
      }),
    );
  }

  /**
   * Converte URLs relativas de imagem (/uploads/...) para absolutas usando o baseUrl da request.
   * URLs já absolutas são retornadas sem alteração.
   */
  resolveProductImageUrls<T extends { image?: string | null; images?: string[] }>(
    product: T,
    baseUrl: string,
  ): T {
    const abs = (url: string | null | undefined): string | null | undefined => {
      if (!url) return url;
      if (url.startsWith('http://') || url.startsWith('https://')) return url;
      return `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
    };
    return {
      ...product,
      image: abs(product.image) as string | null | undefined,
      images: (product.images ?? []).map((img) => abs(img) as string),
    };
  }

  /**
   * Deriva os campos image, images e primaryImageIndex a partir do DTO.
   * Regras do documento product-images-api.md:
   * - Se images vier preenchido, processa uploads e usa-o como fonte da verdade.
   * - primaryImageIndex padrão 0.
   * - image == images[primaryImageIndex] (backward-compat).
   * - Se images vier vazio/omitido mas image vier, usa o campo legado.
   */
  private async resolveImageFields(dto: {
    image?: string | null;
    images?: string[];
    primaryImageIndex?: number;
  }): Promise<{ image: string | null; images: string[]; primaryImageIndex: number }> {
    if (dto.images && dto.images.length > 0) {
      const processed = await this.processImagesArray(dto.images);
      const idx = dto.primaryImageIndex ?? 0;
      return {
        images: processed,
        primaryImageIndex: idx,
        image: processed[idx] ?? processed[0] ?? null,
      };
    }

    // Sem images — usa campo legado image (pode ser null)
    if (dto.image !== undefined) {
      const imgUrl = dto.image
        ? (await this.processImagesArray([dto.image]))[0]
        : null;
      return {
        images: imgUrl ? [imgUrl] : [],
        primaryImageIndex: 0,
        image: imgUrl,
      };
    }

    // Nada enviado — sem alteração de imagem (retorna undefined-like para PATCH ignorar)
    return { image: null, images: [], primaryImageIndex: 0 };
  }

  /**
   * Recalcula o `availableStock` (restante) de uma variação quando o organizador altera o
   * LIMITE (`stock`). Aplica o DELTA do limite sobre o restante atual e faz clamp em [0, novoStock],
   * preservando vendas/holds em andamento — em vez de sobrescrever o restante com o novo limite.
   * Ex.: limite 10→15 com 3 vendidos (restante 7) → restante 12. Limite 10→8 (restante 7) → 5.
   */
  private computeNextAvailableStock(
    oldStock: number,
    oldAvailable: number,
    newStock: number,
  ): number {
    const delta = (newStock ?? 0) - (oldStock ?? 0);
    return Math.max(0, Math.min((oldAvailable ?? 0) + delta, newStock ?? 0));
  }

  /**
   * Valida e normaliza `variationGroups` (400 em pt-BR): nome da variação obrigatório e único
   * no kit, ao menos 1 opção, nomes de opção obrigatórios e únicos na variação (trim +
   * case-insensitive). "Sem interesse" é reservado — o back cria/remove sozinho.
   */
  private normalizeVariationGroups(groups: ProductVariationGroupDto[]): NormalizedVariationGroup[] {
    const seenGroups = new Set<string>();
    return groups.map((g) => {
      const name = (g.name ?? '').trim();
      if (!name) throw new BadRequestException('Informe o nome de todas as variações do kit.');
      if (seenGroups.has(name.toLowerCase())) {
        throw new BadRequestException(`Já existe uma variação chamada "${name}" neste kit.`);
      }
      seenGroups.add(name.toLowerCase());
      if (!g.variations?.length) {
        throw new BadRequestException(`A variação "${name}" precisa de pelo menos uma opção.`);
      }
      const seenOptions = new Set<string>();
      return {
        id: g.id,
        name,
        variations: g.variations.map((o) => {
          const optionName = (o.name ?? '').trim();
          if (!optionName) {
            throw new BadRequestException(`Informe o nome de todas as opções da variação "${name}".`);
          }
          if (isNoInterestVariation({ name: optionName })) {
            throw new BadRequestException(
              `"${DEFAULT_NO_INTEREST_VARIATION_NAME}" é reservado e não pode ser usado como opção.`,
            );
          }
          if (seenOptions.has(optionName.toLowerCase())) {
            throw new BadRequestException(`A opção "${optionName}" está repetida na variação "${name}".`);
          }
          seenOptions.add(optionName.toLowerCase());
          return { id: o.id, name: optionName, price: o.price, stock: o.stock };
        }),
      };
    });
  }

  /**
   * Cliente antigo (`variationType` + `variations`): tudo num único grupo — o 1º existente
   * (preserva o id) ou um novo. "Sem interesse" sai da lista (é tratado à parte).
   */
  private legacyVariationsToGroups(
    variationType: string | null | undefined,
    variations: ProductVariationDto[],
    firstGroup?: { id: string; name: string } | null,
  ): ProductVariationGroupDto[] {
    const options = variations.filter((v) => !isNoInterestVariation(v));
    if (options.length === 0) return [];
    return [
      {
        id: firstGroup?.id,
        name: variationType?.trim() || firstGroup?.name || 'Variação',
        variations: options.map((o) => ({ id: o.id, name: o.name, price: o.price, stock: o.stock })),
      },
    ];
  }

  /**
   * "Sem interesse" no fluxo com `variationGroups`: `isRequired` explícito manda (regra de
   * sempre: opcional ⇒ opt-out); sem o campo (saiu do modal), kit NÃO incluso tem opt-out e
   * incluso não tem.
   */
  private wantsNoInterest(isRequired: boolean | undefined, isIncludedInTicket: boolean): boolean {
    return isRequired !== undefined ? !isRequired : !isIncludedInTicket;
  }

  /** Ids de opções do produto já usadas em compras (variationId legado + variationIds). */
  private async findReferencedVariationIds(client: any, productId: string): Promise<Set<string>> {
    const rows = (await client.$queryRaw(Prisma.sql`
      SELECT DISTINCT x.id::text AS id
      FROM "RegistrationProduct" rp
      CROSS JOIN LATERAL unnest(array_append(rp."variationIds", rp."variationId")) AS x(id)
      WHERE rp."productId" = ${productId}::uuid AND x.id IS NOT NULL
    `)) as { id: string }[];
    return new Set((rows ?? []).map((r) => r.id));
  }

  /**
   * Aplica `groups` ao produto: grupos/opções com id são atualizados no lugar (preserva FKs),
   * novos são criados e ausentes removidos. Opção com venda NUNCA é apagada (mesma regra de
   * antes): sai do grupo (`groupId = null`) e some de `variationGroups`, preservando o histórico.
   * "Sem interesse" (sem grupo) é mantido/criado quando `wantNoInterest`; senão removido (se
   * não tiver venda) — nunca apagado só por não vir em `variationGroups`.
   * @returns snapshot das opções p/ auditoria.
   */
  private async syncVariationGroups(
    tx: any,
    productId: string,
    existing: {
      variations: {
        id: string;
        name: string;
        price: number;
        stock: number;
        availableStock: number;
        groupId: string | null;
      }[];
      variationGroups: { id: string; name: string }[];
    },
    groups: NormalizedVariationGroup[],
    wantNoInterest: boolean,
  ): Promise<ProductVariationAuditSnapshot[]> {
    const referenced =
      existing.variations.length > 0
        ? await this.findReferencedVariationIds(tx, productId)
        : new Set<string>();
    const existingGroupIds = new Set(existing.variationGroups.map((g) => g.id));
    const kept = new Set<string>();
    const keptGroups = new Set<string>();
    const audit: ProductVariationAuditSnapshot[] = [];

    if (wantNoInterest) {
      const noInterest = existing.variations.find((v) => !v.groupId && isNoInterestVariation(v));
      if (noInterest) {
        kept.add(noInterest.id);
      } else {
        await tx.productVariation.create({
          data: {
            productId,
            name: DEFAULT_NO_INTEREST_VARIATION_NAME,
            price: 0,
            stock: 0,
            availableStock: 0,
            sortOrder: 0,
          },
        });
      }
      audit.push({ name: DEFAULT_NO_INTEREST_VARIATION_NAME, price: 0, stock: 0 });
    }

    // sortOrder = índice no array (grupos e opções).
    for (const [gi, g] of groups.entries()) {
      let groupId: string;
      if (g.id && existingGroupIds.has(g.id) && !keptGroups.has(g.id)) {
        await tx.productVariationGroup.update({
          where: { id: g.id },
          data: { name: g.name, sortOrder: gi },
        });
        groupId = g.id;
      } else {
        const created = await tx.productVariationGroup.create({
          data: { productId, name: g.name, sortOrder: gi },
          select: { id: true },
        });
        groupId = created.id;
      }
      keptGroups.add(groupId);

      for (const [oi, o] of g.variations.entries()) {
        // Match por id; sem id (cliente antigo), pelo nome no mesmo grupo (ou opção sem grupo).
        const byId = o.id
          ? existing.variations.find((v) => v.id === o.id && !kept.has(v.id) && !isNoInterestVariation(v))
          : undefined;
        const match =
          byId ??
          (!o.id
            ? existing.variations.find(
                (v) =>
                  !kept.has(v.id) &&
                  !isNoInterestVariation(v) &&
                  (v.groupId === groupId || !v.groupId) &&
                  v.name.trim().toLowerCase() === o.name.toLowerCase(),
              )
            : undefined);
        if (match) {
          const price = o.price !== undefined ? Math.round(o.price) : match.price;
          const stock = o.stock ?? match.stock;
          // Ajusta o restante pelo DELTA do limite (preserva vendas/holds em andamento).
          const availableStock = this.computeNextAvailableStock(match.stock, match.availableStock, stock);
          await tx.productVariation.update({
            where: { id: match.id },
            data: { name: o.name, price, stock, availableStock, sortOrder: oi, groupId },
          });
          kept.add(match.id);
          audit.push({ name: o.name, price, stock, group: g.name });
        } else {
          const price = Math.round(o.price ?? 0);
          const stock = o.stock ?? 0;
          await tx.productVariation.create({
            data: { productId, groupId, name: o.name, price, stock, availableStock: stock, sortOrder: oi },
          });
          audit.push({ name: o.name, price, stock, group: g.name });
        }
      }
    }

    // Opções que saíram: com venda → só desliga do grupo; sem venda → apaga.
    const removed = existing.variations.filter((v) => !kept.has(v.id));
    const toDetach = removed.filter((v) => referenced.has(v.id) && v.groupId);
    const toDelete = removed.filter((v) => !referenced.has(v.id));
    if (toDetach.length > 0) {
      await tx.productVariation.updateMany({
        where: { id: { in: toDetach.map((v) => v.id) } },
        data: { groupId: null },
      });
    }
    if (toDelete.length > 0) {
      await tx.productVariation.deleteMany({ where: { id: { in: toDelete.map((v) => v.id) } } });
    }
    // Grupos que saíram (as opções com venda já foram desligadas → o cascade não as apaga).
    const groupsToDelete = existing.variationGroups.filter((g) => !keptGroups.has(g.id));
    if (groupsToDelete.length > 0) {
      await tx.productVariationGroup.deleteMany({
        where: { id: { in: groupsToDelete.map((g) => g.id) } },
      });
    }
    return audit;
  }

  private normalizeBuyerVariationEditForCreate(dto: CreateProductDto): {
    buyerVariationEditAllowed: boolean;
    variationEditDeadlineDays: number;
  } {
    const allowed = dto.buyerVariationEditAllowed ?? false;
    if (!allowed) {
      return { buyerVariationEditAllowed: false, variationEditDeadlineDays: 0 };
    }
    const raw = dto.variationEditDeadlineDays;
    let days: number;
    if (raw === undefined || raw === null || Number.isNaN(Number(raw))) {
      days = 30;
    } else {
      days = Math.round(Number(raw));
      if (days < 0 || days > 9999) {
        throw new BadRequestException(
          'variationEditDeadlineDays must be an integer between 0 and 9999',
        );
      }
    }
    return { buyerVariationEditAllowed: true, variationEditDeadlineDays: days };
  }

  /**
   * Mescla regras de edição de variação pelo comprador em PATCH (campos opcionais).
   */
  private mergeBuyerVariationEditForUpdate(
    product: {
      buyerVariationEditAllowed: boolean;
      variationEditDeadlineDays: number;
    },
    dto: UpdateProductDto,
  ): { buyerVariationEditAllowed: boolean; variationEditDeadlineDays: number } | null {
    if (
      dto.buyerVariationEditAllowed === undefined &&
      dto.variationEditDeadlineDays === undefined
    ) {
      return null;
    }

    const dtoAllowed = dto.buyerVariationEditAllowed;
    const dtoDays = dto.variationEditDeadlineDays;
    const prevAllowed = product.buyerVariationEditAllowed;
    const prevDays = product.variationEditDeadlineDays;

    const nextAllowed = dtoAllowed !== undefined ? dtoAllowed : prevAllowed;

    let nextDays: number;
    if (!nextAllowed) {
      nextDays = 0;
    } else if (dtoDays !== undefined) {
      if (Number.isNaN(Number(dtoDays))) {
        throw new BadRequestException(
          'variationEditDeadlineDays must be a valid integer between 0 and 9999',
        );
      }
      nextDays = Math.round(Number(dtoDays));
      if (nextDays < 0 || nextDays > 9999) {
        throw new BadRequestException(
          'variationEditDeadlineDays must be an integer between 0 and 9999',
        );
      }
    } else if (!prevAllowed && dtoAllowed === true) {
      nextDays = 30;
    } else {
      nextDays = prevDays;
    }

    return {
      buyerVariationEditAllowed: nextAllowed,
      variationEditDeadlineDays: nextDays,
    };
  }

  async create(
    userId: string,
    eventId: string,
    createProductDto: CreateProductDto,
    clientIp?: string | null,
    baseUrl?: string,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();
    const isRequired = createProductDto.isRequired ?? false;
    const withGroups = createProductDto.variationGroups !== undefined;
    // Com `variationGroups` ele manda; sem (cliente antigo), variationType + variations viram 1 grupo.
    const groups = this.normalizeVariationGroups(
      withGroups
        ? createProductDto.variationGroups!
        : this.legacyVariationsToGroups(createProductDto.variationType, createProductDto.variations ?? []),
    );
    const wantNoInterest = withGroups
      ? this.wantsNoInterest(createProductDto.isRequired, createProductDto.isIncludedInTicket ?? false)
      : !isRequired;

    // Validações (cliente antigo: ao menos uma variação, como antes)
    if (!withGroups && groups.length === 0 && !wantNoInterest) {
      throw new BadRequestException('Product must have at least one variation');
    }

    const buyerVariation = this.normalizeBuyerVariationEditForCreate(createProductDto);

    const { image, images, primaryImageIndex } = await this.resolveImageFields(createProductDto);

    const product = await prismaWrite.$transaction(async (tx: any) => {
      const created = await tx.product.create({
        data: {
          name: createProductDto.name,
          image,
          images,
          primaryImageIndex,
          isIncludedInTicket: createProductDto.isIncludedInTicket ?? false,
          isKit: createProductDto.isKit ?? false,
          basePrice: Math.round(createProductDto.basePrice ?? 0), // entrada já em centavos (INT)
          isRequired,
          // Legado: nome da 1ª variação.
          variationType: groups[0]?.name ?? (withGroups ? null : createProductDto.variationType ?? null),
          buyerVariationEditAllowed: buyerVariation.buyerVariationEditAllowed,
          variationEditDeadlineDays: buyerVariation.variationEditDeadlineDays,
          eventId,
        },
        select: { id: true },
      });
      await this.syncVariationGroups(
        tx,
        created.id,
        { variations: [], variationGroups: [] },
        groups,
        wantNoInterest,
      );
      return tx.product.findUnique({
        where: { id: created.id },
        include: PRODUCT_VARIATIONS_INCLUDE,
      });
    });

    const eventRecord = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { organizationId: true, name: true },
    });
    if (eventRecord) {
      await this.organizationsService.recordOrganizationAuditLog({
        organizationId: eventRecord.organizationId,
        actorUserId: userId,
        ip: clientIp ?? null,
        action: `Criou o produto "${product.name}" do evento "${eventRecord.name}"`,
        metadata: {
          kind: 'PRODUCT_CREATE',
          eventId,
          productId: product.id,
          changes: [
            {
              field: 'produto',
              old: null,
              new: {
                id: product.id,
                name: product.name,
                image: product.image,
                isIncludedInTicket: product.isIncludedInTicket,
                basePrice: product.basePrice,
                isRequired: product.isRequired,
                variationType: product.variationType,
                buyerVariationEditAllowed: product.buyerVariationEditAllowed,
                variationEditDeadlineDays: product.variationEditDeadlineDays,
                variations: product.variations.map((v: any) => ({
                  name: v.name,
                  price: v.price,
                  stock: v.stock,
                })),
                variationGroups: product.variationGroups.map((g: any) => ({
                  name: g.name,
                  variations: g.variations.map((v: any) => v.name),
                })),
              },
            },
          ],
        } as Prisma.InputJsonValue,
      });
    }

    const resolved = baseUrl
      ? this.resolveProductImageUrls(product, baseUrl)
      : product;

    return {
      message: 'Product created successfully',
      data: { product: resolved },
    };
  }

  /**
   * Valida o voucher informado no link de checkout (?voucher=CODE) antes de listar produtos.
   * Erros tipados (422, mesmo padrão de código+mensagem do patchCoupon em orders) para o front
   * exibir o motivo real — em especial "já foi utilizado" — em vez do 400 genérico de whitelist.
   * Vouchers reservados por outro pedido NÃO são barrados aqui: a exclusividade da reserva é
   * decidida na aplicação (patchCoupon/pay), onde o pedido dono é conhecido.
   */
  private async assertVoucherUsable(
    prismaRead: ReturnType<PrismaService['getReadClient']>,
    eventId: string,
    code: string,
  ): Promise<void> {
    // `code` é único global (@unique no schema) — lookup por índice + checagem de evento.
    const voucher = await prismaRead.voucher.findUnique({
      where: { code: code.toUpperCase().trim() },
      select: { eventId: true, status: true, expiryDate: true, deletedAt: true },
    });

    if (!voucher || voucher.eventId !== eventId || voucher.deletedAt) {
      throw new UnprocessableEntityException({
        code: 'VOUCHER_NOT_FOUND',
        message: 'Voucher não encontrado ou inválido',
      });
    }
    if (voucher.status === VoucherStatus.USED) {
      throw new UnprocessableEntityException({
        code: 'VOUCHER_ALREADY_USED',
        message: 'Este voucher já foi utilizado',
      });
    }
    if (
      voucher.status === VoucherStatus.EXPIRED ||
      (voucher.expiryDate && new Date(voucher.expiryDate) < new Date())
    ) {
      throw new UnprocessableEntityException({
        code: 'VOUCHER_EXPIRED',
        message: 'Voucher expirado',
      });
    }
    if (voucher.status !== VoucherStatus.ACTIVE) {
      // INACTIVE (ou estados futuros) — trata como inválido sem vazar detalhe interno.
      throw new UnprocessableEntityException({
        code: 'VOUCHER_NOT_FOUND',
        message: 'Voucher não encontrado ou inválido',
      });
    }
  }

  /**
   * Sobrescreve `variation.soldCount` (contador DENORMALIZADO — decrementado a cada estorno e
   * que NUNCA somou vendas do finalize legado, logo fica menor que o real) pela contagem REAL
   * de `RegistrationProduct` por variação: SUM(quantity) de inscrições VÁLIDAS
   * (CONFIRMED/COMPLETED) com pagamento PAID. Estorno/chargeback rebaixam a inscrição p/
   * CANCELLED → saem da conta sozinhos; vendas legadas válidas voltam a contar.
   * Payment é 1-por-order (upsert por orderId), então o JOIN não duplica.
   */
  private async overrideVariationSoldCounts(
    prismaRead: any,
    products: {
      id: string;
      variations?: { id: string; soldCount?: number }[];
      variationGroups?: { variations?: { id: string; soldCount?: number }[] }[];
    }[],
  ): Promise<void> {
    const variationIds = products.flatMap((p) => (p.variations ?? []).map((v) => v.id));
    if (variationIds.length === 0) return;
    // Filtro por produto (indexado) antes do unnest — evita varrer a tabela inteira.
    const productIds = products.map((p) => p.id);

    // Cada opção escolhida conta (kit com várias variações): `variationIds`, ou o
    // `variationId` legado quando a lista está vazia.
    const rows = (await prismaRead.$queryRaw(Prisma.sql`
      SELECT x.vid::text AS "variationId", SUM(rp.quantity)::bigint AS sold
      FROM "RegistrationProduct" rp
      CROSS JOIN LATERAL unnest(
        CASE WHEN cardinality(rp."variationIds") > 0 THEN rp."variationIds" ELSE ARRAY[rp."variationId"] END
      ) AS x(vid)
      INNER JOIN "Registration" r ON r.id = rp."registrationId"
      INNER JOIN "Order" o ON o.id = r."orderId"
      INNER JOIN "Payment" p ON p."orderId" = o.id
      WHERE rp."productId" = ANY(${productIds}::uuid[])
        AND x.vid = ANY(${variationIds}::uuid[])
        AND r.status::text IN ('CONFIRMED', 'COMPLETED')
        AND p.status::text = 'PAID'
      GROUP BY x.vid
    `)) as { variationId: string; sold: bigint }[];

    const soldMap = new Map<string, number>(
      rows.map((row) => [row.variationId, Number(row.sold)]),
    );
    for (const p of products) {
      const all = [
        ...(p.variations ?? []),
        ...(p.variationGroups ?? []).flatMap((g) => g.variations ?? []),
      ];
      for (const v of all) {
        v.soldCount = soldMap.get(v.id) ?? 0;
      }
    }
  }

  async findAll(eventId: string, filterDto: FilterProductsDto = {}, baseUrl?: string) {
    const prismaRead = this.prisma.getReadClient();

    // Voucher do link de checkout: valida ANTES de listar para devolver o motivo real
    // (ex.: já utilizado) em vez de seguir num fluxo de compra que vai falhar depois.
    if (filterDto.voucher) {
      await this.assertVoucherUsable(prismaRead, eventId, filterDto.voucher);
    }

    const page = filterDto.page || 1;
    const limit = filterDto.limit || 20;
    const skip = (page - 1) * limit;

    const activeWhere = { eventId, deletedAt: null };
    const [products, total] = await Promise.all([
      prismaRead.product.findMany({
        where: activeWhere,
        skip,
        take: limit,
        include: PRODUCT_VARIATIONS_INCLUDE,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      prismaRead.product.count({ where: activeWhere }),
    ]);

    const totalPages = Math.ceil(total / limit);

    const resolvedProducts = baseUrl
      ? products.map((p) => this.resolveProductImageUrls(p, baseUrl))
      : products;

    // "Total vendidos" = contagem REAL de RegistrationProduct (não o soldCount denormalizado).
    await this.overrideVariationSoldCounts(prismaRead, resolvedProducts as any);

    return {
      message: 'Products fetched successfully',
      data: {
        products: resolvedProducts,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      },
    };
  }

  async findOne(id: string, baseUrl?: string) {
    const prismaRead = this.prisma.getReadClient();
    const product = await prismaRead.product.findUnique({
      where: { id },
      include: {
        ...PRODUCT_VARIATIONS_INCLUDE,
        event: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const resolved = baseUrl
      ? this.resolveProductImageUrls(product, baseUrl)
      : product;

    // "Total vendidos" = contagem REAL de RegistrationProduct (não o soldCount denormalizado).
    await this.overrideVariationSoldCounts(prismaRead, [resolved as any]);

    return {
      message: 'Product fetched successfully',
      data: { product: resolved },
    };
  }

  async update(
    userId: string,
    eventId: string,
    productId: string,
    updateProductDto: UpdateProductDto,
    clientIp?: string | null,
    baseUrl?: string,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const product = await prismaWrite.product.findUnique({
      where: { id: productId },
      include: {
        tickets: true,
        variations: {
          select: { id: true, name: true, price: true, stock: true, availableStock: true, groupId: true },
          orderBy: { sortOrder: 'asc' },
        },
        variationGroups: {
          select: { id: true, name: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    if (!product || product.eventId !== eventId) {
      throw new NotFoundException('Product not found');
    }

    // Não permitir atualizar produtos vinculados a ingressos vendidos
    // TODO: Verificar se há registrations com esses tickets

    const updateData: Record<string, unknown> = { ...updateProductDto };
    delete updateData.variations;
    delete updateData.variationGroups;
    delete updateData.buyerVariationEditAllowed;
    delete updateData.variationEditDeadlineDays;
    // Campos de imagem são resolvidos separadamente abaixo
    delete updateData.image;
    delete updateData.images;
    delete updateData.primaryImageIndex;
    for (const k of Object.keys(updateData)) {
      if (updateData[k] === undefined) {
        delete updateData[k];
      }
    }

    if (updateData.basePrice !== undefined) {
      updateData.basePrice = Math.round(Number(updateData.basePrice));
    }

    // Resolve campos de imagem somente se o DTO trouxer ao menos um deles
    const hasImageFields =
      updateProductDto.image !== undefined ||
      updateProductDto.images !== undefined;
    if (hasImageFields) {
      const resolved = await this.resolveImageFields(updateProductDto);
      updateData.image = resolved.image;
      updateData.images = resolved.images;
      updateData.primaryImageIndex = resolved.primaryImageIndex;
    }

    const mergedBuyerVariation = this.mergeBuyerVariationEditForUpdate(
      product,
      updateProductDto,
    );
    if (mergedBuyerVariation) {
      updateData.buyerVariationEditAllowed =
        mergedBuyerVariation.buyerVariationEditAllowed;
      updateData.variationEditDeadlineDays =
        mergedBuyerVariation.variationEditDeadlineDays;
    }

    const scalarOnlyForAudit = { ...updateData };
    let newVariationsSnapshot: ProductVariationAuditSnapshot[] | null = null;

    // Com `variationGroups` ele manda; sem (cliente antigo), `variations` vira 1 grupo (o 1Âº).
    const withGroups = updateProductDto.variationGroups !== undefined;
    let groups: NormalizedVariationGroup[] | null = null;
    let wantNoInterest = false;
    if (withGroups) {
      groups = this.normalizeVariationGroups(updateProductDto.variationGroups!);
      wantNoInterest = this.wantsNoInterest(
        updateProductDto.isRequired,
        updateProductDto.isIncludedInTicket ?? product.isIncludedInTicket,
      );
      // Legado: nome da 1Âª variaÃ§Ã£o.
      updateData.variationType = groups[0]?.name ?? null;
    } else if (updateProductDto.variations) {
      groups = this.normalizeVariationGroups(
        this.legacyVariationsToGroups(
          updateProductDto.variationType,
          updateProductDto.variations,
          product.variationGroups[0] ?? null,
        ),
      );
      wantNoInterest = !(updateProductDto.isRequired ?? product.isRequired);
      if (groups.length === 0 && !wantNoInterest) {
        throw new BadRequestException('Product must have at least one variation');
      }
      if (groups[0]) updateData.variationType = groups[0].name;
    }

    const updatedProduct = await prismaWrite.$transaction(async (tx: any) => {
      if (groups) {
        newVariationsSnapshot = await this.syncVariationGroups(
          tx,
          productId,
          product,
          groups,
          wantNoInterest,
        );
      } else if (updateProductDto.variationType !== undefined && product.variationGroups[0]) {
        // Cliente antigo renomeando sÃ³ o tipo: renomeia o 1Âº grupo (variationType = legado dele).
        const name = updateProductDto.variationType?.trim();
        if (name) {
          await tx.productVariationGroup.update({
            where: { id: product.variationGroups[0].id },
            data: { name },
          });
        }
      }
      return tx.product.update({
        where: { id: productId },
        data: updateData as Prisma.ProductUpdateInput,
        include: PRODUCT_VARIATIONS_INCLUDE,
      });
    });

    const { labels: auditLabels, changes: auditChanges } =
      summarizeProductUpdateForAudit(
        product as unknown as ProductBeforeAudit,
        scalarOnlyForAudit,
        updateProductDto,
        newVariationsSnapshot,
      );

    const eventRecord = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { organizationId: true, name: true },
    });
    if (eventRecord) {
      await this.organizationsService.recordOrganizationAuditLog({
        organizationId: eventRecord.organizationId,
        actorUserId: userId,
        ip: clientIp ?? null,
        action: `Editou o produto "${updatedProduct.name}" do evento "${eventRecord.name}"`,
        metadata: {
          kind: 'PRODUCT_UPDATE',
          eventId,
          productId,
          fieldsEdited: auditLabels,
          changes: auditChanges,
        } as Prisma.InputJsonValue,
      });
    }

    const resolved = baseUrl
      ? this.resolveProductImageUrls(updatedProduct, baseUrl)
      : updatedProduct;

    return {
      message: 'Product updated successfully',
      data: { product: resolved },
    };
  }

  async remove(
    userId: string,
    eventId: string,
    productId: string,
    clientIp?: string | null,
  ) {
    await this.verifyOrganizerAccess(userId, eventId);

    const prismaWrite = this.prisma.getWriteClient();
    const prismaRead = this.prisma.getReadClient();

    const product = await prismaWrite.product.findUnique({
      where: { id: productId },
      include: {
        variations: { orderBy: { sortOrder: 'asc' } },
      },
    });

    if (!product || product.eventId !== eventId) {
      throw new NotFoundException('Product not found');
    }

    const eventRecord = await prismaRead.event.findUnique({
      where: { id: eventId },
      select: { organizationId: true, name: true },
    });
    if (eventRecord) {
      await this.organizationsService.recordOrganizationAuditLog({
        organizationId: eventRecord.organizationId,
        actorUserId: userId,
        ip: clientIp ?? null,
        action: `Excluiu o produto "${product.name}" do evento "${eventRecord.name}"`,
        metadata: {
          kind: 'PRODUCT_DELETE',
          eventId,
          productId,
          changes: [
            {
              field: 'produto',
              old: {
                id: product.id,
                name: product.name,
                image: product.image,
                isIncludedInTicket: product.isIncludedInTicket,
                basePrice: product.basePrice,
                isRequired: product.isRequired,
                variationType: product.variationType,
                buyerVariationEditAllowed: product.buyerVariationEditAllowed,
                variationEditDeadlineDays: product.variationEditDeadlineDays,
                variations: product.variations.map((v) => ({
                  name: v.name,
                  price: v.price,
                  stock: v.stock,
                })),
              },
              new: null,
            },
          ],
        } as Prisma.InputJsonValue,
      });
    }

    const hasPurchases = await prismaRead.registrationProduct.count({ where: { productId } }) > 0;

    await prismaWrite.$transaction(async (tx) => {
      // Remove associação com ingressos e kits independente do tipo de delete
      await tx.ticketProduct.deleteMany({ where: { productId } });
      await tx.kitItem.updateMany({
        where: { productId },
        data: { productId: null },
      });

      const ev = await tx.event.findUnique({
        where: { id: eventId },
        select: { kitSelectionDisplay: true },
      });
      if (ev?.kitSelectionDisplay != null) {
        const { next, changed } = stripDeletedProductFromKitSelectionDisplay(
          ev.kitSelectionDisplay,
          productId,
        );
        if (changed) {
          await tx.event.update({
            where: { id: eventId },
            data: { kitSelectionDisplay: next },
          });
        }
      }

      if (hasPurchases) {
        // Soft delete: preserva o registro para manter histórico de compras
        await tx.product.update({
          where: { id: productId },
          data: { deletedAt: new Date() },
        });
      } else {
        await tx.product.delete({ where: { id: productId } });
      }
    });

    return {
      message: 'Product deleted successfully',
    };
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
      throw new NotFoundException('Event not found');
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
      throw new BadRequestException('User is not a member of this event\'s organization');
    }
  }
}
