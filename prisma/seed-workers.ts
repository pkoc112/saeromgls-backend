import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const WORKERS = [
  { name: '강재구', phone: '010-7672-5878', code: 'WRK101' },
  { name: '공대용', phone: '010-6755-8586', code: 'WRK102' },
  { name: '권승렬', phone: '010-5326-2310', code: 'WRK103' },
  { name: '김대호', phone: '010-7753-0245', code: 'WRK104' },
  { name: '김병우', phone: '010-6314-3862', code: 'WRK105' },
  { name: '김진욱', phone: '010-8266-9265', code: 'WRK106' },
  { name: '남상욱', phone: '010-2538-5541', code: 'WRK107' },
  { name: '박근남', phone: '010-5091-7806', code: 'WRK108' },
  { name: '심원식', phone: '010-5523-5146', code: 'WRK109' },
  { name: '전영길', phone: '010-3139-9421', code: 'WRK110' },
  { name: '주원호', phone: '010-3948-6909', code: 'WRK111' },
  { name: '최민', phone: '010-5684-9588', code: 'WRK112' },
  { name: '허경희', phone: '010-9323-9500', code: 'WRK113' },
];

async function main() {
  const pin = await bcrypt.hash('1234', 10);

  // Delete old corrupted workers (WRK101-WRK113)
  await prisma.worker.deleteMany({
    where: {
      employeeCode: {
        in: WORKERS.map((w) => w.code),
      },
    },
  });

  for (const w of WORKERS) {
    const worker = await prisma.worker.create({
      data: {
        name: w.name,
        employeeCode: w.code,
        pin,
        role: 'WORKER',
        status: 'ACTIVE',
      },
    });
    console.log(`Created: ${worker.name} (${worker.employeeCode})`);
  }

  console.log(`\nTotal: ${WORKERS.length} workers created`);
  console.log('Default PIN for all workers: 1234');
}

main()
  .catch((e) => {
    console.error('Failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
