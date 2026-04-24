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
 */
export const PAYMENT_DETAILS_STANDARD_INCLUDE = {
  order: {
    include: {
      event: {
        include: {
          organization: {
            include: {
              members: {
                where: { role: 'OWNER' as const },
                include: {
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
