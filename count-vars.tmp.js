const { PrismaClient } = require("@prisma/client");
(async () => {
  const p = new PrismaClient();
  const productId = "6493d897-fc37-4aec-8311-09b28f14f3e4"; // PODIO2
  const existing = await p.productVariation.findMany({ where: { productId }, select: { name: true } });
  const have = new Set(existing.map(v => v.name));
  const sizes = ["XPP","PP2","M2","G2","GG2","XG2","XXG","EG","EGG","Especial 1","Especial 2","Especial 3"];
  let sort = existing.length;
  for (const name of sizes) {
    if (have.has(name)) continue;
    await p.productVariation.create({ data: { productId, name, price: 0, stock: 10, sortOrder: sort++ } });
  }
  console.log("variações PODIO2:", await p.productVariation.count({ where: { productId } }));
  await p.$disconnect();
})();
