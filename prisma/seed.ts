import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // ---- 작업자 시드 데이터 ----
  const adminPin = await bcrypt.hash('0000', 10);
  const supervisorPin = await bcrypt.hash('1111', 10);
  const workerPin = await bcrypt.hash('2222', 10);

  const admin = await prisma.worker.upsert({
    where: { employeeCode: 'ADM001' },
    update: {},
    create: {
      name: '관리자',
      employeeCode: 'ADM001',
      pin: adminPin,
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  });
  console.log(`  Created admin: ${admin.name} (${admin.employeeCode})`);

  const supervisor = await prisma.worker.upsert({
    where: { employeeCode: 'SUP001' },
    update: {},
    create: {
      name: '반장김',
      employeeCode: 'SUP001',
      pin: supervisorPin,
      role: 'SUPERVISOR',
      status: 'ACTIVE',
    },
  });
  console.log(`  Created supervisor: ${supervisor.name} (${supervisor.employeeCode})`);

  const worker = await prisma.worker.upsert({
    where: { employeeCode: 'WRK001' },
    update: {},
    create: {
      name: '작업자이',
      employeeCode: 'WRK001',
      pin: workerPin,
      role: 'WORKER',
      status: 'ACTIVE',
    },
  });
  console.log(`  Created worker: ${worker.name} (${worker.employeeCode})`);

  // ---- 분류 시드 데이터 ----
  const classifications = [
    { code: 'DC', displayName: 'DC (물류센터)', sortOrder: 1 },
    { code: 'AGENCY', displayName: 'AGENCY (대리점)', sortOrder: 2 },
    { code: 'CVS', displayName: 'CVS (편의점)', sortOrder: 3 },
  ];

  for (const cls of classifications) {
    const created = await prisma.classification.upsert({
      where: { code: cls.code },
      update: {},
      create: {
        code: cls.code,
        displayName: cls.displayName,
        sortOrder: cls.sortOrder,
        isActive: true,
      },
    });
    console.log(`  Created classification: ${created.code} - ${created.displayName}`);
  }

  console.log('\nSeed completed successfully!');
  console.log('\nDefault PINs:');
  console.log('  관리자 (ADM001): 0000');
  console.log('  반장김 (SUP001): 1111');
  console.log('  작업자이 (WRK001): 2222');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
