/**
 * create-admin.ts
 *
 * Creates or updates an ADMIN user.
 *
 * Usage:
 *   pnpm ts-node --project tsconfig.node.json prisma/create-admin.ts <email> <password> [firstName] [lastName]
 *
 * Examples:
 *   pnpm ts-node --project tsconfig.node.json prisma/create-admin.ts admin@podio.com Admin123!
 *   pnpm ts-node --project tsconfig.node.json prisma/create-admin.ts admin@podio.com Admin123! Joao Silva
 */

import { PrismaClient, AccountType, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const [, , emailArg, passwordArg, firstNameArg, lastNameArg] = process.argv;

async function main() {
  if (!emailArg || !passwordArg) {
    console.error('Usage: create-admin.ts <email> <password> [firstName] [lastName]');
    process.exit(1);
  }

  const email = emailArg.trim().toLowerCase();
  const firstName = firstNameArg?.trim() || 'Admin';
  const lastName = lastNameArg?.trim() || 'Podio';
  const hash = await bcrypt.hash(passwordArg, 12);

  const existing = await prisma.user.findFirst({
    where: { email, accountType: AccountType.USER },
    select: { id: true, role: true },
  });

  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { password: hash, role: UserRole.ADMIN, isActive: true },
    });
    console.log(`\nUpdated existing user → ADMIN\n  id:    ${existing.id}\n  email: ${email}\n  role:  ${existing.role} → ADMIN\n`);
  } else {
    const user = await prisma.user.create({
      data: {
        email,
        password: hash,
        firstName,
        lastName,
        accountType: AccountType.USER,
        role: UserRole.ADMIN,
        isActive: true,
        acceptedTerms: true,
        acceptedPrivacyPolicy: true,
      },
      select: { id: true },
    });
    console.log(`\nCreated ADMIN user\n  id:    ${user.id}\n  email: ${email}\n  name:  ${firstName} ${lastName}\n`);
  }
}

main()
  .catch((e) => {
    console.error('\n❌', e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
