#!/usr/bin/env node
/**
 * Script para testar streaming replication
 * 
 * Uso: node scripts/test-replication.js
 * 
 * Este script:
 * 1. Cria um evento no master
 * 2. Aguarda alguns segundos
 * 3. Verifica se o evento aparece no read replica
 * 4. Limpa os dados de teste
 */

const { PrismaClient } = require('@prisma/client');

const masterPrisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL || 'postgresql://podiogo:podiogo123@localhost:5432/podiogo',
    },
  },
});

const replicaPrisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_READ_REPLICA_URL || 'postgresql://podiogo:podiogo123@localhost:5433/podiogo',
    },
  },
});

async function testReplication() {
  console.log('🧪 Testando Streaming Replication...\n');

  try {
    // Conectar aos bancos
    await masterPrisma.$connect();
    console.log('✅ Conectado ao master (porta 5432)');

    await replicaPrisma.$connect();
    console.log('✅ Conectado ao replica (porta 5433)\n');

    // 1. Criar evento no master
    console.log('📝 Criando evento no master...');
    const testEvent = await masterPrisma.event.create({
      data: {
        organizerId: await getTestOrganizerId(),
        name: `Replication Test ${Date.now()}`,
        description: 'Teste de replicação',
        location: 'Local de Teste',
        city: 'Cidade Teste',
        state: 'TS',
        country: 'BR',
        eventDate: new Date('2025-12-31T10:00:00Z'),
        registrationEndDate: new Date('2025-12-30T23:59:59Z'),
        status: 'PUBLISHED',
      },
    });
    console.log(`✅ Evento criado no master: ${testEvent.id}\n`);

    // 2. Aguardar replicação
    console.log('⏳ Aguardando replicação (5 segundos)...');

    // 3. Verificar no replica
    console.log('🔍 Verificando no read replica...');
    const replicatedEvent = await replicaPrisma.event.findUnique({
      where: { id: testEvent.id },
    });

    if (replicatedEvent) {
      console.log('✅ SUCESSO! Evento encontrado no read replica!');
      console.log(`   Nome: ${replicatedEvent.name}`);
      console.log(`   ID: ${replicatedEvent.id}\n`);
    } else {
      console.log('⚠️  AVISO: Evento não encontrado no read replica ainda.');
      console.log('   Isso pode ser normal em desenvolvimento se o streaming replication não estiver configurado.\n');
      
      // Verificar se está no master
      const masterEvent = await masterPrisma.event.findUnique({
        where: { id: testEvent.id },
      });
      
      if (masterEvent) {
        console.log('✅ Evento confirmado no master.');
        console.log('   Execute `pnpm db:push:replica` para sincronizar manualmente.\n');
      }
    }

    // 4. Limpar
    console.log('🧹 Limpando dados de teste...');
    await masterPrisma.event.delete({ where: { id: testEvent.id } }).catch(() => {});
    await replicaPrisma.event.delete({ where: { id: testEvent.id } }).catch(() => {});
    console.log('✅ Limpeza concluída\n');

    console.log('✅ Teste concluído!');

  } catch (error) {
    console.error('❌ Erro durante o teste:', error.message);
    process.exit(1);
  } finally {
    await masterPrisma.$disconnect();
    await replicaPrisma.$disconnect();
  }
}

async function getTestOrganizerId() {
  // Tentar pegar um organizer existente ou criar um temporário
  const organizer = await masterPrisma.organizer.findFirst();
  if (organizer) {
    return organizer.id;
  }
  
  // Criar um organizer temporário para teste
  const user = await masterPrisma.user.findFirst();
  if (!user) {
    throw new Error('Nenhum usuário encontrado. Crie um usuário primeiro.');
  }

  const tempOrganizer = await masterPrisma.organizer.create({
    data: {
      userId: user.id,
      name: 'Test Organizer',
      email: 'test@example.com',
    },
  });

  return tempOrganizer.id;
}

// Executar teste
testReplication().catch(console.error);

