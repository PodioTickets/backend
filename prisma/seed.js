const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const modalitiesTemplates = [
  {
    code: 'corrida',
    label: 'Corrida',
    icon: '/icons-3d/Icon3D-corrida-de-rua.webp',
  },
  { code: 'natacao', label: 'Natação', icon: '/icons-3d/Icon3D-natacao.webp' },
  {
    code: 'ciclismo',
    label: 'Ciclismo',
    icon: '/icons-3d/Icon3D-ciclismo.webp',
  },
  {
    code: 'triathlon',
    label: 'Triathlon',
    icon: '/icons-3d/Icon-3D-Triathlon.webp',
  },
  { code: 'outros', label: 'Outros', icon: '/icons-3d/Icon3D-outros.webp' },
];

async function main() {
  console.log('🌱 Seeding modality templates...');

  for (const template of modalitiesTemplates) {
    await prisma.modalityTemplate.upsert({
      where: { code: template.code },
      update: {
        label: template.label,
        icon: template.icon,
        isActive: true,
      },
      create: {
        code: template.code,
        label: template.label,
        icon: template.icon,
        isActive: true,
      },
    });
  }

  console.log(`✅ Seeded ${modalitiesTemplates.length} modality templates`);
}

main()
  .catch((e) => {
    console.error('❌ Error seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

