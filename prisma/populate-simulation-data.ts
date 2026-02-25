import { PrismaClient, PaymentStatus, PaymentMethod, RegistrationStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function resetEventData(eventId: string) {
  console.log('🔄 Resetando dados do evento...\n');

  // Deletar registrations (cascata deleta RegistrationTicket, RegistrationModality, etc.)
  const deletedRegistrations = await prisma.registration.deleteMany({
    where: { eventId },
  });
  console.log(`   ✅ ${deletedRegistrations.count} inscrições deletadas`);

  // Deletar payments (que estão vinculados aos orders)
  const deletedPayments = await prisma.payment.deleteMany({
    where: {
      order: {
        eventId,
      },
    },
  });
  console.log(`   ✅ ${deletedPayments.count} pagamentos deletados`);

  // Deletar orders
  const deletedOrders = await prisma.order.deleteMany({
    where: { eventId },
  });
  console.log(`   ✅ ${deletedOrders.count} pedidos deletados\n`);

  console.log('✅ Dados do evento resetados com sucesso!\n');
}

async function main() {
  console.log('🚀 Iniciando população de dados de simulação...\n');

  // 1. Buscar um evento existente (obrigatório)
  const event = await prisma.event.findFirst({
    where: { status: 'PUBLISHED' },
    include: {
      tickets: {
        where: { isActive: true },
        include: {
          batches: {
            orderBy: { createdAt: 'desc' },
          },
          products: {
            include: {
              product: {
                include: {
                  variations: true,
                },
              },
            },
          },
        },
      },
      modalities: {
        where: { isActive: true },
      },
    },
  });

  if (!event) {
    throw new Error('❌ Nenhum evento publicado encontrado. Crie um evento publicado primeiro.');
  }

  console.log(`✅ Evento encontrado: ${event.name} (${event.id})`);
  console.log(`   📋 Tickets disponíveis: ${event.tickets.length}`);
  console.log(`   🏃 Modalidades disponíveis: ${event.modalities.length}\n`);

  if (event.tickets.length === 0) {
    throw new Error('❌ O evento não possui tickets. Crie tickets para o evento primeiro.');
  }

  // Resetar dados existentes do evento
  await resetEventData(event.id);

  // 2. Buscar ou criar usuários com nomes realistas
  const firstNames = [
    'João', 'Maria', 'Pedro', 'Ana', 'Carlos', 'Mariana', 'Paulo', 'Juliana',
    'Lucas', 'Fernanda', 'Rafael', 'Patricia', 'Gabriel', 'Camila', 'Bruno', 'Amanda',
    'Felipe', 'Larissa', 'Rodrigo', 'Beatriz', 'Thiago', 'Carolina', 'André', 'Vanessa',
    'Marcos', 'Isabela', 'Ricardo', 'Renata', 'Gustavo', 'Priscila', 'Diego', 'Tatiana',
    'Leonardo', 'Monique', 'Eduardo', 'Bruna', 'Vinicius', 'Débora', 'Henrique', 'Leticia',
  ];

  const lastNames = [
    'Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves', 'Pereira',
    'Lima', 'Gomes', 'Ribeiro', 'Carvalho', 'Almeida', 'Lopes', 'Martins', 'Rocha',
    'Costa', 'Ramos', 'Reis', 'Nascimento', 'Moreira', 'Mendes', 'Barros', 'Freitas',
    'Araújo', 'Barbosa', 'Cavalcanti', 'Dias', 'Monteiro', 'Cardoso', 'Teixeira', 'Moraes',
  ];

  const cities = [
    { city: 'São Paulo', state: 'SP' },
    { city: 'Rio de Janeiro', state: 'RJ' },
    { city: 'Belo Horizonte', state: 'MG' },
    { city: 'Curitiba', state: 'PR' },
    { city: 'Porto Alegre', state: 'RS' },
    { city: 'Salvador', state: 'BA' },
    { city: 'Brasília', state: 'DF' },
    { city: 'Fortaleza', state: 'CE' },
    { city: 'Recife', state: 'PE' },
    { city: 'Manaus', state: 'AM' },
  ];

  // Deletar usuários antigos de simulação (com emails que começam com "simulacao" ou nomes "Usuário Simulação")
  console.log('🧹 Limpando usuários antigos de simulação...');
  const deletedOldUsers = await prisma.user.deleteMany({
    where: {
      OR: [
        { email: { startsWith: 'simulacao' } },
        { firstName: 'Usuário', lastName: { startsWith: 'Simulação' } },
      ],
    },
  });
  console.log(`   ✅ ${deletedOldUsers.count} usuários antigos deletados\n`);

  // Buscar usuários existentes (que não são de simulação)
  const existingUsers = await prisma.user.findMany({
    take: 40,
    where: {
      NOT: {
        OR: [
          { email: { startsWith: 'simulacao' } },
          { firstName: 'Usuário', lastName: { startsWith: 'Simulação' } },
        ],
      },
    },
  });

  const usersToCreate = 40 - existingUsers.length;
  const users: any[] = [...existingUsers];

  if (usersToCreate > 0) {
    console.log(`📝 Criando ${usersToCreate} usuários com nomes realistas...`);
    const hashedPassword = await bcrypt.hash('123456', 12);

    // Gerar combinações únicas de nomes
    const usedNames = new Set<string>();

    for (let i = 0; i < usersToCreate; i++) {
      let firstName: string;
      let lastName: string;
      let fullName: string;

      // Garantir nomes únicos
      do {
        firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
        lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
        fullName = `${firstName} ${lastName}`;
      } while (usedNames.has(fullName) && usedNames.size < firstNames.length * lastNames.length);

      usedNames.add(fullName);

      const location = cities[i % cities.length];
      // Gerar email único baseado no nome e timestamp
      const emailBase = `${firstName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')}.${lastName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')}`;
      const email = `${emailBase}@gmail.com`;

      // Verificar se email já existe (raro, mas possível)
      const existingUserByEmail = await prisma.user.findUnique({
        where: { email },
      });

      if (existingUserByEmail) {
        // Se email existe, adicionar número aleatório
        const finalEmail = `${emailBase}@gmail.com`;

        const user = await prisma.user.create({
          data: {
            email: finalEmail,
            password: hashedPassword,
            firstName: firstName,
            lastName: lastName,
            phone: `11${String(900000000 + i).padStart(9, '0')}`, // Telefones realistas
            city: location.city,
            state: location.state,
            country: 'Brasil',
            acceptedTerms: true,
            acceptedPrivacyPolicy: true,
          },
        });
        users.push(user);
      } else {
        const user = await prisma.user.create({
          data: {
            email: email,
            password: hashedPassword,
            firstName: firstName,
            lastName: lastName,
            phone: `11${String(900000000 + i).padStart(9, '0')}`, // Telefones realistas
            city: location.city,
            state: location.state,
            country: 'Brasil',
            acceptedTerms: true,
            acceptedPrivacyPolicy: true,
          },
        });
        users.push(user);
      }
    }
    console.log(`✅ ${usersToCreate} usuários criados\n`);
  }

  console.log(`✅ Total de usuários disponíveis: ${users.length}\n`);

  // 3. Preparar dados do evento
  const tickets = event.tickets;
  const modalities = event.modalities;

  // Função auxiliar para calcular preço do ticket (usar batch mais recente)
  const getTicketPrice = (ticket: any): number => {
    if (ticket.batches && ticket.batches.length > 0) {
      return ticket.batches[0].price; // Preço em reais
    }
    return 149.90; // Fallback
  };

  // Função auxiliar para calcular preço da modality
  const getModalityPrice = (modality: any): number => {
    return modality.price; // Preço em reais
  };

  // 4. Criar os pedidos conforme especificação
  const orders: any[] = [];
  const now = new Date();

  // Distribuição de inscrições:
  // - 3 pedidos com 2 inscrições cada = 6 inscrições
  // - 2 pedidos com 3 inscrições cada = 6 inscrições
  // - 25 pedidos com 1 inscrição cada = 25 inscrições
  // Total: 37 inscrições em 30 pedidos

  let userIndex = 0;
  let registrationCount = 0;

  // 20 pedidos pagos
  console.log('📦 Criando 20 pedidos pagos...');
  for (let i = 0; i < 20; i++) {
    const buyer = users[userIndex % users.length];
    userIndex++;

    // Selecionar ticket aleatório do evento
    const selectedTicket = tickets[Math.floor(Math.random() * tickets.length)];
    const ticketPrice = getTicketPrice(selectedTicket);

    // Selecionar modality aleatória (se houver)
    const selectedModality = modalities.length > 0
      ? modalities[Math.floor(Math.random() * modalities.length)]
      : null;
    const modalityPrice = selectedModality ? getModalityPrice(selectedModality) : 0;

    // Calcular valores (em centavos)
    const baseAmount = Math.round((ticketPrice + modalityPrice) * 100);
    const serviceFee = Math.round(baseAmount * 0.05); // 5% de taxa
    const totalAmount = baseAmount;
    const finalAmount = totalAmount + serviceFee;

    const order = await prisma.order.create({
      data: {
        userId: buyer.id,
        eventId: event.id,
        totalAmount: totalAmount / 100, // Converter para reais
        serviceFee: serviceFee / 100,
        discount: 0,
        finalAmount: finalAmount / 100,
        createdAt: new Date(now.getTime() - (20 - i) * 24 * 60 * 60 * 1000), // Distribuir ao longo de 20 dias
      },
    });

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        userId: buyer.id,
        method: PaymentMethod.CREDIT_CARD,
        status: PaymentStatus.PAID,
        amount: finalAmount / 100,
        transactionId: `TXN-${Date.now()}-${i}`,
        paymentDate: order.createdAt,
        metadata: {
          creditCard: {
            installments: Math.random() > 0.5 ? 1 : Math.floor(Math.random() * 3) + 2, // 1, 2 ou 3 parcelas
            installmentValue: (finalAmount / 100) / (Math.random() > 0.5 ? 1 : Math.floor(Math.random() * 3) + 2),
          },
        },
      },
    });

    // Determinar quantas inscrições criar para este pedido
    let registrationsToCreate = 1;
    if (i < 3) {
      registrationsToCreate = 2; // Primeiros 3 pedidos têm 2 inscrições
    } else if (i === 3 || i === 4) {
      registrationsToCreate = 3; // Próximos 2 pedidos têm 3 inscrições
    }

    // Criar as inscrições
    for (let j = 0; j < registrationsToCreate; j++) {
      const participant = users[userIndex % users.length];
      userIndex++;

      const registration = await prisma.registration.create({
        data: {
          eventId: event.id,
          orderId: order.id,
          userId: participant.id,
          status: RegistrationStatus.CONFIRMED,
          qrCode: `QR-${order.id}-${j}`,
          termsAccepted: true,
          rulesAccepted: true,
          createdAt: order.createdAt,
        },
      });

      // Vincular ticket à inscrição
      await prisma.registrationTicket.create({
        data: {
          registrationId: registration.id,
          ticketId: selectedTicket.id,
        },
      });

      // Vincular modality à inscrição (se houver)
      if (selectedModality) {
        await prisma.registrationModality.create({
          data: {
            registrationId: registration.id,
            modalityId: selectedModality.id,
          },
        });
      }

      registrationCount++;
    }

    orders.push({ order, payment, registrationsCount: registrationsToCreate });
  }
  console.log(`✅ 20 pedidos pagos criados (${registrationCount} inscrições)\n`);

  // 5 pedidos cancelados
  console.log('📦 Criando 5 pedidos cancelados...');
  for (let i = 0; i < 5; i++) {
    const buyer = users[userIndex % users.length];
    userIndex++;

    // Selecionar ticket aleatório
    const selectedTicket = tickets[Math.floor(Math.random() * tickets.length)];
    const ticketPrice = getTicketPrice(selectedTicket);
    const selectedModality = modalities.length > 0
      ? modalities[Math.floor(Math.random() * modalities.length)]
      : null;
    const modalityPrice = selectedModality ? getModalityPrice(selectedModality) : 0;

    const baseAmount = Math.round((ticketPrice + modalityPrice) * 100);
    const serviceFee = Math.round(baseAmount * 0.05);
    const totalAmount = baseAmount;
    const finalAmount = totalAmount + serviceFee;

    const order = await prisma.order.create({
      data: {
        userId: buyer.id,
        eventId: event.id,
        totalAmount: totalAmount / 100,
        serviceFee: serviceFee / 100,
        discount: 0,
        finalAmount: finalAmount / 100,
        createdAt: new Date(now.getTime() - (5 - i) * 24 * 60 * 60 * 1000),
      },
    });

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        userId: buyer.id,
        method: PaymentMethod.CREDIT_CARD,
        status: PaymentStatus.PAID, // Pagamento foi feito, mas depois cancelado
        amount: finalAmount / 100,
        transactionId: `TXN-${Date.now()}-${20 + i}`,
        paymentDate: order.createdAt,
      },
    });

    // Criar 1 inscrição cancelada
    const participant = users[userIndex % users.length];
    userIndex++;

    const registration = await prisma.registration.create({
      data: {
        eventId: event.id,
        orderId: order.id,
        userId: participant.id,
        status: RegistrationStatus.CANCELLED,
        qrCode: `QR-${order.id}-0`,
        termsAccepted: true,
        rulesAccepted: true,
        createdAt: order.createdAt,
      },
    });

    // Vincular ticket à inscrição
    await prisma.registrationTicket.create({
      data: {
        registrationId: registration.id,
        ticketId: selectedTicket.id,
      },
    });

    // Vincular modality (se houver)
    if (selectedModality) {
      await prisma.registrationModality.create({
        data: {
          registrationId: registration.id,
          modalityId: selectedModality.id,
        },
      });
    }

    registrationCount++;
    orders.push({ order, payment, registrationsCount: 1 });
  }
  console.log(`✅ 5 pedidos cancelados criados\n`);

  // 3 chargeback (refunded com metadata CHARGEBACK)
  console.log('📦 Criando 3 pedidos com CHARGEBACK...');
  for (let i = 0; i < 3; i++) {
    const buyer = users[userIndex % users.length];
    userIndex++;

    const selectedTicket = tickets[Math.floor(Math.random() * tickets.length)];
    const ticketPrice = getTicketPrice(selectedTicket);
    const selectedModality = modalities.length > 0
      ? modalities[Math.floor(Math.random() * modalities.length)]
      : null;
    const modalityPrice = selectedModality ? getModalityPrice(selectedModality) : 0;

    const baseAmount = Math.round((ticketPrice + modalityPrice) * 100);
    const serviceFee = Math.round(baseAmount * 0.05);
    const totalAmount = baseAmount;
    const finalAmount = totalAmount + serviceFee;

    const order = await prisma.order.create({
      data: {
        userId: buyer.id,
        eventId: event.id,
        totalAmount: totalAmount / 100,
        serviceFee: serviceFee / 100,
        discount: 0,
        finalAmount: finalAmount / 100,
        createdAt: new Date(now.getTime() - (3 - i) * 24 * 60 * 60 * 1000),
      },
    });

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        userId: buyer.id,
        method: PaymentMethod.CREDIT_CARD,
        status: PaymentStatus.REFUNDED, // Chargeback = refunded com metadata específico
        amount: finalAmount / 100,
        transactionId: `TXN-CHARGEBACK-${Date.now()}-${25 + i}`,
        paymentDate: order.createdAt,
        metadata: {
          refundType: 'CHARGEBACK',
          reason: 'Chargeback solicitado pelo banco',
          chargebackDate: new Date().toISOString(),
        },
      },
    });

    // Criar 1 inscrição cancelada (porque foi estornada)
    const participant = users[userIndex % users.length];
    userIndex++;

    const registration = await prisma.registration.create({
      data: {
        eventId: event.id,
        orderId: order.id,
        userId: participant.id,
        status: RegistrationStatus.CANCELLED,
        qrCode: `QR-${order.id}-0`,
        termsAccepted: true,
        rulesAccepted: true,
        createdAt: order.createdAt,
      },
    });

    // Vincular ticket à inscrição
    await prisma.registrationTicket.create({
      data: {
        registrationId: registration.id,
        ticketId: selectedTicket.id,
      },
    });

    // Vincular modality (se houver)
    if (selectedModality) {
      await prisma.registrationModality.create({
        data: {
          registrationId: registration.id,
          modalityId: selectedModality.id,
        },
      });
    }

    registrationCount++;
    orders.push({ order, payment, registrationsCount: 1 });
  }
  console.log(`✅ 3 pedidos com chargeback criados\n`);

  // 2 pedidos estornados (refunded com metadata REFUND)
  console.log('📦 Criando 2 pedidos ESTORNADOS (refund)...');
  for (let i = 0; i < 2; i++) {
    const buyer = users[userIndex % users.length];
    userIndex++;

    const selectedTicket = tickets[Math.floor(Math.random() * tickets.length)];
    const ticketPrice = getTicketPrice(selectedTicket);
    const selectedModality = modalities.length > 0
      ? modalities[Math.floor(Math.random() * modalities.length)]
      : null;
    const modalityPrice = selectedModality ? getModalityPrice(selectedModality) : 0;

    const baseAmount = Math.round((ticketPrice + modalityPrice) * 100);
    const serviceFee = Math.round(baseAmount * 0.05);
    const totalAmount = baseAmount;
    const finalAmount = totalAmount + serviceFee;

    const order = await prisma.order.create({
      data: {
        userId: buyer.id,
        eventId: event.id,
        totalAmount: totalAmount / 100,
        serviceFee: serviceFee / 100,
        discount: 0,
        finalAmount: finalAmount / 100,
        createdAt: new Date(now.getTime() - (2 - i) * 24 * 60 * 60 * 1000),
      },
    });

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        userId: buyer.id,
        method: PaymentMethod.CREDIT_CARD,
        status: PaymentStatus.REFUNDED, // Estornado = refunded com metadata REFUND
        amount: finalAmount / 100,
        transactionId: `TXN-REFUND-${Date.now()}-${28 + i}`,
        paymentDate: order.createdAt,
        metadata: {
          refundType: 'REFUND',
          reason: 'Estorno solicitado pelo cliente',
          refundDate: new Date().toISOString(),
        },
      },
    });

    // Criar 1 inscrição cancelada (porque foi estornada)
    const participant = users[userIndex % users.length];
    userIndex++;

    const registration = await prisma.registration.create({
      data: {
        eventId: event.id,
        orderId: order.id,
        userId: participant.id,
        status: RegistrationStatus.CANCELLED,
        qrCode: `QR-${order.id}-0`,
        termsAccepted: true,
        rulesAccepted: true,
        createdAt: order.createdAt,
      },
    });

    // Vincular ticket à inscrição
    await prisma.registrationTicket.create({
      data: {
        registrationId: registration.id,
        ticketId: selectedTicket.id,
      },
    });

    // Vincular modality (se houver)
    if (selectedModality) {
      await prisma.registrationModality.create({
        data: {
          registrationId: registration.id,
          modalityId: selectedModality.id,
        },
      });
    }

    registrationCount++;
    orders.push({ order, payment, registrationsCount: 1 });
  }
  console.log(`✅ 2 pedidos estornados criados\n`);

  // Verificar os dados criados
  const paidCount = await prisma.payment.count({
    where: {
      order: { eventId: event.id },
      status: PaymentStatus.PAID,
    },
  });

  const cancelledCount = await prisma.registration.count({
    where: {
      eventId: event.id,
      status: RegistrationStatus.CANCELLED,
    },
  });

  // Buscar todos os pagamentos refunded e filtrar por metadata
  const allRefundedPayments = await prisma.payment.findMany({
    where: {
      order: { eventId: event.id },
      status: PaymentStatus.REFUNDED,
    },
    select: {
      id: true,
      metadata: true,
    },
  });

  const chargebackCount = allRefundedPayments.filter((p) => {
    const metadata = p.metadata as any;
    return metadata?.refundType === 'CHARGEBACK';
  }).length;

  const refundCount = allRefundedPayments.filter((p) => {
    const metadata = p.metadata as any;
    return metadata?.refundType === 'REFUND';
  }).length;

  // Resumo
  console.log('\n📊 Resumo da simulação:');
  console.log(`   ✅ Evento usado: ${event.name}`);
  console.log(`   ✅ Tickets disponíveis: ${tickets.length}`);
  console.log(`   ✅ Modalidades disponíveis: ${modalities.length}`);
  console.log(`   ✅ Total de pedidos criados: ${orders.length}`);
  console.log(`   ✅ Total de inscrições criadas: ${registrationCount}`);
  console.log(`\n📈 Verificação dos dados criados:`);
  console.log(`   ✅ Pedidos pagos: ${paidCount} (esperado: 20)`);
  console.log(`   ✅ Inscrições canceladas: ${cancelledCount} (esperado: 10)`);
  console.log(`   ✅ Pedidos com CHARGEBACK: ${chargebackCount} (esperado: 3)`);
  console.log(`   ✅ Pedidos ESTORNADOS (REFUND): ${refundCount} (esperado: 2)`);
  console.log(`\n🎉 População de dados de simulação concluída!\n`);
}

main()
  .catch((e) => {
    console.error('❌ Erro ao popular dados:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
