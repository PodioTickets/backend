import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const modalitiesTemplates = [
  // Coluna 1
  {
    code: 'corrida-de-rua',
    label: 'Corrida de rua',
    icon: '/icons-3d/Icon3D-corrida-de-rua.webp',
  },
  { code: 'natacao', label: 'Natação', icon: '/icons-3d/Icon3D-natacao.webp' },
  {
    code: 'caminhada',
    label: 'Caminhada',
    icon: '/icons-3d/Icon3D-caminhada.webp',
  },
  { code: 'criancas', label: 'Crianças', icon: '/icons-3d/Icon3D-kids.webp' },
  { code: 'praia', label: 'Praia', icon: '/icons-3d/Icon3D-praia.webp' },
  { code: 'ate-4k', label: 'Até 4k', icon: '/icons-3d/Icon3D-4k.webp' },
  { code: '42k', label: '42k', icon: '/icons-3d/Icon3D-42K.webp' },

  // Coluna 2
  {
    code: 'ciclismo',
    label: 'Ciclismo',
    icon: '/icons-3d/Icon3D-ciclismo.webp',
  },
  { code: 'uphill', label: 'Uphill', icon: '/icons-3d/Icon3D-Uphill.webp' },
  {
    code: 'corridas-virtuais',
    label: 'Corridas virtuais',
    icon: '/icons-3d/Icon3D-corrida-virtual.webp',
  },
  {
    code: 'grupos-esportivos',
    label: 'Grupos esportivos',
    icon: '/icons-3d/Icon3D-Grupo-de-pessoa.webp',
  },
  {
    code: 'circuito',
    label: 'Circuito',
    icon: '/icons-3d/Icon3D-circuito.webp',
  },
  {
    code: 'de-5k-a-10k',
    label: 'De 5k a 10k',
    icon: '/icons-3d/Icon3D-10k.webp',
  },
  {
    code: 'ciclismo-montanha',
    label: 'Ciclismo na montanha',
    icon: '/icons-3d/Icon3D-Ciclismo-montanha.webp',
  },

  // Coluna 3
  {
    code: 'corrida-aventura',
    label: 'Corrida de aventura',
    icon: '/icons-3d/Icon3D-Corrida aventura.webp',
  },
  {
    code: 'corrida-noturna',
    label: 'Corrida noturna',
    icon: '/icons-3d/Icon3D-Corrida-noturna.webp',
  },
  {
    code: 'beach-tennis',
    label: 'Beach tennis',
    icon: '/icons-3d/Icon3D-Beach-tennis.webp',
  },
  {
    code: 'canoagem-vaa',
    label: "Canoagem va'a",
    icon: '/icons-3d/Icon3D-canoa.webp',
  },
  {
    code: 'de-11k-a-20k',
    label: 'De 11k a 20k',
    icon: '/icons-3d/Icon3D-11k-a-20k.webp',
  },
  {
    code: 'triathlon',
    label: 'Triathlon',
    icon: '/icons-3d/Icon-3D-Triathlon.webp',
  },
  {
    code: 'corrida-trilha',
    label: 'Corrida em trilha',
    icon: '/icons-3d/Icon3D-Corrida-em-trilha.webp',
  },

  // Coluna 4
  {
    code: 'so-mulheres',
    label: 'Só mulheres',
    icon: '/icons-3d/Icon3D-mulheres.webp',
  },
  {
    code: 'futevolei',
    label: 'Futevôlei',
    icon: '/icons-3d/Icon3D-futevolei.webp',
  },
  {
    code: 'capacitacao',
    label: 'Capacitação',
    icon: '/icons-3d/Icon3D-corrida-de-revezamento.webp',
  },
  { code: '21k', label: '21k', icon: '/icons-3d/Icon3D-21k.webp' },
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
