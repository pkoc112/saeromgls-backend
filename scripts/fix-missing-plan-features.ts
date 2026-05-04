/**
 * 운영 DB Plan.features에 누락된 항목만 추가 (idempotent, add-only).
 *
 * 절대 features를 제거·재정렬·정리하지 않는다.
 * 운영자가 의도해서 추가한 항목(DASHBOARD/AI_INSIGHT 등)은 그대로 보존한다.
 *
 * 실행 후 audit-plan-features.ts로 결과 검증.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// 각 플랜에 "있어야 하는데 빠진 게 있으면 추가만 하라"는 목록.
// 운영 정책 변경 시 이곳만 수정.
const REQUIRED_PER_PLAN: Record<string, string[]> = {
  FREE: [],
  BASIC: ['PERFORMANCE', 'INCENTIVE', 'CSV_EXPORT', 'REPORTS', 'ACTIVITY_LOGS'],
  PRO: [
    'PERFORMANCE', 'INCENTIVE', 'CSV_EXPORT', 'REPORTS', 'ACTIVITY_LOGS',
    'AI_INSIGHT', 'ADVANCED_REPORT', 'DATA_PROTECTION',
  ],
  ENTERPRISE: [
    'PERFORMANCE', 'INCENTIVE', 'CSV_EXPORT', 'REPORTS', 'ACTIVITY_LOGS',
    'AI_INSIGHT', 'ADVANCED_REPORT', 'DATA_PROTECTION', 'API_ACCESS',
  ],
};

async function main() {
  let changed = 0;

  for (const [code, required] of Object.entries(REQUIRED_PER_PLAN)) {
    const plan = await prisma.plan.findUnique({ where: { code } });
    if (!plan) {
      console.log(`[${code}] not found → skip (필요 시 별도 생성 스크립트)`);
      continue;
    }

    const current = plan.features ?? [];
    const missing = required.filter((f) => !current.includes(f));

    if (missing.length === 0) {
      console.log(`[${code}] OK — 누락 없음`);
      continue;
    }

    const next = [...current, ...missing];
    await prisma.plan.update({
      where: { code },
      data: { features: next },
    });

    console.log(`[${code}] +${missing.length}: ${JSON.stringify(missing)}`);
    console.log(`        before: ${JSON.stringify(current)}`);
    console.log(`        after : ${JSON.stringify(next)}`);
    changed++;
  }

  console.log('\n─'.repeat(20));
  console.log(changed === 0 ? '✅ 변경 없음' : `✅ ${changed}개 플랜 features 추가 완료`);

  // 검증: 다시 읽기
  const all = await prisma.plan.findMany({
    select: { code: true, features: true },
    orderBy: { priceMonthly: 'asc' },
  });
  console.log('\n=== AFTER ===');
  for (const p of all) {
    console.log(`  ${p.code.padEnd(12)} ${JSON.stringify(p.features)}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => prisma.$disconnect());
