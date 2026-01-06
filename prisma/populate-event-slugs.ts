import { PrismaClient } from '@prisma/client';
import { generateUniqueSlug } from '../src/helpers/SlugHelper';

const prisma = new PrismaClient();

/**
 * Verifica se um slug já existe no banco de dados
 */
async function slugExists(slug: string, excludeEventId?: string): Promise<boolean> {
  const event = await prisma.event.findUnique({
    where: { slug },
    select: { id: true },
  });

  if (!event) return false;

  // Se estamos atualizando um evento, ignorar o próprio evento
  if (excludeEventId && event.id === excludeEventId) {
    return false;
  }

  return true;
}

/**
 * Gera um slug único para o evento
 */
async function generateEventSlug(
  name: string,
  excludeEventId?: string,
): Promise<string> {
  return generateUniqueSlug(name, (slug) =>
    slugExists(slug, excludeEventId),
  );
}

async function main() {
  console.log('🔄 Buscando eventos sem slug...');

  // Buscar todos os eventos que não têm slug
  const eventsWithoutSlug = await prisma.event.findMany({
    where: {
      slug: null,
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (eventsWithoutSlug.length === 0) {
    console.log('✅ Todos os eventos já possuem slug!');
    return;
  }

  console.log(`📝 Encontrados ${eventsWithoutSlug.length} eventos sem slug`);
  console.log('🚀 Gerando slugs...\n');

  let successCount = 0;
  let errorCount = 0;

  for (const event of eventsWithoutSlug) {
    try {
      // Gerar slug único baseado no nome do evento
      const slug = await generateEventSlug(event.name, event.id);

      // Atualizar o evento com o slug gerado
      await prisma.event.update({
        where: { id: event.id },
        data: { slug },
      });

      console.log(`✅ ${event.name} → ${slug}`);
      successCount++;
    } catch (error) {
      console.error(`❌ Erro ao gerar slug para "${event.name}" (ID: ${event.id}):`, error);
      errorCount++;
    }
  }

  console.log('\n📊 Resumo:');
  console.log(`   ✅ Sucesso: ${successCount}`);
  console.log(`   ❌ Erros: ${errorCount}`);
  console.log(`   📝 Total processado: ${eventsWithoutSlug.length}`);
}

main()
  .catch((e) => {
    console.error('❌ Erro ao popular slugs:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

