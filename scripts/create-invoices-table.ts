/**
 * Invoice 테이블 생성 (raw SQL) — 매월 자동 청구서 생성용
 * Run: npx ts-node scripts/create-invoices-table.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS invoices (
      id              TEXT PRIMARY KEY,
      site_id         TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      invoice_number  TEXT NOT NULL UNIQUE,
      status          TEXT NOT NULL DEFAULT 'DRAFT',
      amount          INTEGER NOT NULL,
      tax_amount      INTEGER NOT NULL DEFAULT 0,
      total_amount    INTEGER NOT NULL,
      period_start    TIMESTAMP(3) NOT NULL,
      period_end      TIMESTAMP(3) NOT NULL,
      due_date        TIMESTAMP(3) NOT NULL,
      issued_at       TIMESTAMP(3),
      paid_at         TIMESTAMP(3),
      payment_method  TEXT,
      payment_note    TEXT,
      created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('[invoices] table created (or already exists)');

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS invoices_site_id_created_at_idx
      ON invoices (site_id, created_at DESC);
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS invoices_status_due_date_idx
      ON invoices (status, due_date);
  `);
  console.log('[invoices] indexes created');

  const count = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*) AS count FROM invoices`,
  );
  console.log(`[invoices] current row count: ${count[0]?.count ?? 0}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => prisma.$disconnect());
