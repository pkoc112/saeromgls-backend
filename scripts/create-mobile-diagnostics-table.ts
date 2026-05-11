/**
 * MobileDiagnostic 테이블 생성 (raw SQL).
 *
 * 보통은 prisma db push로 처리하지만, 로컬에서 Neon direct URL이 닿지 않아
 * pooled URL을 통해 raw SQL로 테이블 + 인덱스를 생성한다.
 * idempotent (IF NOT EXISTS).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS mobile_diagnostics (
      id                TEXT PRIMARY KEY,
      worker_id         TEXT,
      site_id           TEXT,
      screen            TEXT NOT NULL,
      error_type        TEXT NOT NULL,
      error_message     TEXT,
      http_status       INTEGER,
      has_token         BOOLEAN NOT NULL DEFAULT false,
      token_age_minutes INTEGER,
      network_online    BOOLEAN,
      payload_size      INTEGER,
      app_version       TEXT,
      runtime_version   TEXT,
      platform          TEXT,
      context           JSONB,
      created_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('[mobile_diagnostics] table created (or already exists)');

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS mobile_diagnostics_site_id_created_at_idx
      ON mobile_diagnostics (site_id, created_at DESC);
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS mobile_diagnostics_error_type_created_at_idx
      ON mobile_diagnostics (error_type, created_at DESC);
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS mobile_diagnostics_created_at_idx
      ON mobile_diagnostics (created_at DESC);
  `);
  console.log('[mobile_diagnostics] indexes created');

  // 검증
  const count = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*) AS count FROM mobile_diagnostics`,
  );
  console.log(`[mobile_diagnostics] current row count: ${count[0]?.count ?? 0}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => prisma.$disconnect());
