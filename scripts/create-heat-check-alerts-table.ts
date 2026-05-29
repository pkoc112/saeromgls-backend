/**
 * HeatCheckAlert 테이블 생성 (raw SQL).
 *
 * Neon pooled URL로 raw SQL을 사용해 테이블 + 인덱스를 idempotent 하게 생성.
 * Run: npx ts-node scripts/create-heat-check-alerts-table.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS heat_check_alerts (
      id           TEXT PRIMARY KEY,
      worker_id    TEXT NOT NULL,
      worker_name  TEXT NOT NULL,
      site_id      TEXT,
      result       TEXT NOT NULL,
      symptoms     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      wbgt         DECIMAL(4, 1) NOT NULL,
      temp         DECIMAL(4, 1) NOT NULL,
      humidity     INTEGER NOT NULL,
      slot         TEXT NOT NULL,
      reported_at  TIMESTAMP(3) NOT NULL,
      created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('[heat_check_alerts] table created (or already exists)');

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS heat_check_alerts_site_id_created_at_idx
      ON heat_check_alerts (site_id, created_at DESC);
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS heat_check_alerts_worker_id_created_at_idx
      ON heat_check_alerts (worker_id, created_at DESC);
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS heat_check_alerts_created_at_idx
      ON heat_check_alerts (created_at DESC);
  `);
  console.log('[heat_check_alerts] indexes created');

  // 검증
  const count = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*) AS count FROM heat_check_alerts`,
  );
  console.log(`[heat_check_alerts] current row count: ${count[0]?.count ?? 0}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => prisma.$disconnect());
