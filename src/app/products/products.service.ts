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
import { DEFAULT_NO_INTEREST_VARIATION_NAME } from './product.constants';

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
   * Para produtos não obrigatórios, garante que exista a variação padrão "Sem interesse".
   */
  private ensureDefaultNoInterestVariation(
    isRequired: boolean,
    variations: ProductVariationDto[],
  ): ProductVariationDto[] {
    if (isRequired) return variations;
    const hasNoInterest = variations.some(
      (v) => v.name.trim().toLowerCase() === DEFAULT_NO_INTEREST_VARIATION_NAME.toLowerCase(),
    );
    if (hasNoInterest) return variations;
    return [
      { name: DEFAULT_NO_INTEREST_VARIATION_NAME, price: 0, stock: 0 },
      ...variations,
    ];
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
    const variations = this.ensureDefaultNoInterestVariation(
      isRequired,
      createProductDto.variations,
    );

    // Validações
    if (variations.length === 0) {
      throw new BadRequestException('Product must have at least one variation');
    }

    const buyerVariation = this.normalizeBuyerVariationEditForCreate(createProductDto);

    const { image, images, primaryImageIndex } = await this.resolveImageFields(createProductDto);

    const product = await prismaWrite.product.create({
      data: {
        name: createProductDto.name,
        image,
        images,
        primaryImageIndex,
        isIncludedInTicket: createProductDto.isIncludedInTicket ?? false,
        basePrice: Math.round(createProductDto.basePrice ?? 0), // entrada já em centavos (INT)
        isRequired: createProductDto.isRequired ?? false,
        variationType: createProductDto.variationType,
        buyerVariationEditAllowed: buyerVariation.buyerVariationEditAllowed,
        variationEditDeadlineDays: buyerVariation.variationEditDeadlineDays,
        eventId,
        variations: {
          // sortOrder = posição no array recebido (já vem na ordem desejada do front).
          create: variations.map((v, i) => ({
            name: v.name,
            price: Math.round(v.price ?? 0), // entrada já em centavos (INT)
            stock: v.stock ?? 0,
            availableStock: v.stock ?? 0, // restante parte igual ao limite (nada vendido ainda)
            sortOrder: i,
          })),
        },
      },
      include: {
        variations: { orderBy: { sortOrder: 'asc' } },
      },
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
                variations: product.variations.map((v) => ({
                  name: v.name,
                  price: v.price,
                  stock: v.stock,
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
    products: { variations?: { id: string; soldCount?: number }[] }[],
  ): Promise<void> {
    const variationIds = products.flatMap((p) => (p.variations ?? []).map((v) => v.id));
    if (variationIds.length === 0) return;

    const rows = (await prismaRead.$queryRaw(Prisma.sql`
      SELECT rp."variationId" AS "variationId", SUM(rp.quantity)::bigint AS sold
      FROM "RegistrationProduct" rp
      INNER JOIN "Registration" r ON r.id = rp."registrationId"
      INNER JOIN "Order" o ON o.id = r."orderId"
      INNER JOIN "Payment" p ON p."orderId" = o.id
      WHERE rp."variationId" = ANY(${variationIds}::uuid[])
        AND r.status::text IN ('CONFIRMED', 'COMPLETED')
        AND p.status::text = 'PAID'
      GROUP BY rp."variationId"
    `)) as { variationId: string; sold: bigint }[];

    const soldMap = new Map<string, number>(
      rows.map((row) => [row.variationId, Number(row.sold)]),
    );
    for (const p of products) {
      for (const v of p.variations ?? []) {
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
        include: {
          variations: {
            orderBy: { sortOrder: 'asc' },
          },
        },
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
        variations: {
          orderBy: { sortOrder: 'asc' },
        },
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
          select: { id: true, name: true, price: true, stock: true, availableStock: true },
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

    if (updateProductDto.variations) {
      const isRequired = updateProductDto.isRequired ?? product.isRequired;
      const variations = this.ensureDefaultNoInterestVariation(
        isRequired,
        updateProductDto.variations,
      );

      if (variations.length === 0) {
        throw new BadRequestException('Product must have at least one variation');
      }

      newVariationsSnapshot = variations.map((v) => ({
        name: v.name,
        price: Math.round(v.price ?? 0),
        stock: v.stock ?? 0,
      }));

      // IDs de variações referenciadas por compras — nunca podem ser deletadas
      const referencedRows = await prismaWrite.registrationProduct.findMany({
        where: { productId, variationId: { not: null } },
        select: { variationId: true },
        distinct: ['variationId'],
      });
      const referencedVariationIds = new Set(referencedRows.map((r) => r.variationId as string));

      // Upsert: atualiza variações existentes no lugar (por id ou por nome como fallback)
      // e cria as novas. Nunca recria com novo ID — preserva FKs em RegistrationProduct.
      const incomingIds = new Set(variations.map((v) => v.id).filter(Boolean) as string[]);
      // `i` = posição na lista recebida → recomputa o sortOrder (permite reordenar arrastando).
      for (const [i, v] of variations.entries()) {
        const price = Math.round(v.price ?? 0);
        const stock = v.stock ?? 0;

        if (v.id) {
          // Atualizar pelo ID explícito
          const exists = product.variations.find((pv) => pv.id === v.id);
          if (exists) {
            // Ajusta o restante pelo DELTA do limite (preserva vendas/holds em andamento),
            // nunca sobrescreve availableStock cegamente.
            const availableStock = this.computeNextAvailableStock(exists.stock, exists.availableStock, stock);
            await prismaWrite.productVariation.update({
              where: { id: v.id },
              data: { name: v.name, price, stock, availableStock, sortOrder: i },
            });
          } else {
            // ID enviado mas não existe — criar como nova (restante = limite)
            await prismaWrite.productVariation.create({
              data: { productId, name: v.name, price, stock, availableStock: stock, sortOrder: i },
            });
          }
        } else {
          // Sem ID: tenta match por nome (backwards-compat) antes de criar
          const byName = product.variations.find((pv) => pv.name === v.name);
          if (byName) {
            const availableStock = this.computeNextAvailableStock(byName.stock, byName.availableStock, stock);
            await prismaWrite.productVariation.update({
              where: { id: byName.id },
              data: { price, stock, availableStock, sortOrder: i },
            });
            incomingIds.add(byName.id);
          } else {
            await prismaWrite.productVariation.create({
              data: { productId, name: v.name, price, stock, availableStock: stock, sortOrder: i },
            });
          }
        }
      }

      // Remover variações que saíram da lista e não têm compras vinculadas
      const toDelete = product.variations.filter(
        (pv) => !incomingIds.has(pv.id) && !referencedVariationIds.has(pv.id),
      );
      if (toDelete.length > 0) {
        await prismaWrite.productVariation.deleteMany({
          where: { id: { in: toDelete.map((v) => v.id) } },
        });
      }

      // Não usa o campo `variations` no updateData — as operações acima já aplicaram tudo
      delete updateData.variations;
    }

    const { labels: auditLabels, changes: auditChanges } =
      summarizeProductUpdateForAudit(
        product as unknown as ProductBeforeAudit,
        scalarOnlyForAudit,
        updateProductDto,
        newVariationsSnapshot,
      );

    const updatedProduct = await prismaWrite.product.update({
      where: { id: productId },
      data: updateData as Prisma.ProductUpdateInput,
      include: {
        variations: { orderBy: { sortOrder: 'asc' } },
      },
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
