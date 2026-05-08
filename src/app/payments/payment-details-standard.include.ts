import type { Prisma } from '@prisma/client';

/** Mesmos campos que `category: true` em TicketCategory (sem relações aninhadas). */
export const TICKET_CATEGORY_DETAIL_INCLUDE = {
  select: {
    id: true,
    eventId: true,
    name: true,
    description: true,
    order: true,
    createdAt: true,
    updatedAt: true,
  },
} as const;

/**
 * Include compartilhado em getPaymentDetails (transaction / order / payment).
 *
 * Usa selects granulares em `event` e `organization` em vez de `include` cego —
 * o include trazia ~30 colunas por nível (incluindo campos sociais como instagram,
 * facebook, tiktok, youtube, website que não são consumidos por este endpoint).
 * Reduz bytes trafegados do DB e CPU de hidratação Prisma.
 */
export const PAYMENT_DETAILS_STANDARD_INCLUDE = {
  order: {
    include: {
      event: {
        select: {
          id: true,
          name: true,
          slug: true,
          eventDate: true,
          location: true,
          city: true,
          state: true,
          country: true,
          bannerUrl: true,
          logoUrl: true,
          organizationId: true,
          organization: {
            select: {
              id: true,
              name: true,
              tradeName: true,
              logoUrl: true,
              members: {
                where: { role: 'OWNER' as const },
                select: {
                  userId: true,
                  role: true,
                  user: {
                    select: {
                      id: true,
                      firstName: true,
                      lastName: true,
                      email: true,
                      avatarUrl: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
      registrations: {
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              documentNumber: true,
              dateOfBirth: true,
              reservePhone: true,
              gender: true,
            },
          },
          tickets: {
            include: {
              ticket: {
                include: {
                  category: TICKET_CATEGORY_DETAIL_INCLUDE,
                },
              },
            },
          },
        },
      },
    },
  },
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      documentNumber: true,
      dateOfBirth: true,
      reservePhone: true,
      gender: true,
    },
  },
} satisfies Prisma.PaymentInclude;
