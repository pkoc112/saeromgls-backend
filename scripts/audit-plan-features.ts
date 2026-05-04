/**
 * 운영 DB Plan.features 완전 점검 (read-only).
 *
 * 코드의 @Feature() 데코레이터 사용처 vs DB에 저장된 features 배열을 대조해서
 * 플랜별로 어떤 feature가 빠져 있는지 보고한다.
 *
 * 절대 mutation 금지. 결과만 출력.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// 코드에서 @Feature(...)로 게이팅하는 모든 feature.
// src/**/*.controller.ts에서 grep한 결과와 동기화 필수.
const ALL_FEATURES_IN_CODE = [
  'ACTIVITY_LOGS',
  'AI_INSIGHT',
  'CSV_EXPORT',
  'DATA_PROTECTION',
  'INCENTIVE',
  'PERFORMANCE',
  'REPORTS',
  'ADVANCED_REPORT', // 코드 게이팅 없음 (미래 자리)
  'API_ACCESS',      // 코드 게이팅 없음 (미래 자리)
] as const;

// 코드에 없지만 운영 DB에 누적된 레거시 features.
// 무해 — 게이팅 안 됨. 정리는 옵션.
const LEGACY_FEATURES = ['DASHBOARD', 'WORK_ITEMS', 'WORKERS'] as const;

// 플랜별 정책 — 무엇이 "있어야 하는지" 의도.
// 운영자가 추가한 항목까지 포함해서 매칭한다.
const EXPECTED: Record<string, string[]> = {
  FREE: [],
  // BASIC: 운영자 의도로 AI_INSIGHT 포함
  BASIC: [
    'PERFORMANCE', 'INCENTIVE', 'CSV_EXPORT', 'REPORTS', 'ACTIVITY_LOGS',
    'AI_INSIGHT',
  ],
  // PRO: 운영자 의도로 API_ACCESS 포함
  PRO: [
    'PERFORMANCE', 'INCENTIVE', 'CSV_EXPORT', 'REPORTS', 'ACTIVITY_LOGS',
    'AI_INSIGHT', 'ADVANCED_REPORT', 'DATA_PROTECTION', 'API_ACCESS',
  ],
  ENTERPRISE: [
    'PERFORMANCE', 'INCENTIVE', 'CSV_EXPORT', 'REPORTS', 'ACTIVITY_LOGS',
    'AI_INSIGHT', 'ADVANCED_REPORT', 'DATA_PROTECTION', 'API_ACCESS',
  ],
};

async function main() {
  const plans = await prisma.plan.findMany({
    select: { code: true, name: true, features: true, isActive: true },
    orderBy: { priceMonthly: 'asc' },
  });

  console.log('\n=== Plan features 점검 ===\n');
  console.log(`코드에 등록된 전체 feature: ${ALL_FEATURES_IN_CODE.join(', ')}\n`);

  let issueCount = 0;

  for (const p of plans) {
    const expected = EXPECTED[p.code] ?? [];
    const actual = p.features ?? [];

    const missing = expected.filter((f) => !actual.includes(f));
    const legacy = actual.filter((f) => (LEGACY_FEATURES as readonly string[]).includes(f));
    const unknown = actual.filter(
      (f) =>
        !ALL_FEATURES_IN_CODE.includes(f as any) &&
        !(LEGACY_FEATURES as readonly string[]).includes(f),
    );
    const extra = actual.filter(
      (f) => !expected.includes(f) && ALL_FEATURES_IN_CODE.includes(f as any),
    );

    // 차단 이슈만 ISSUE — 레거시·extra는 정보성.
    const status = missing.length === 0 && unknown.length === 0 ? '✅ OK' : '❌ BLOCKED';

    console.log(`[${p.code}] ${p.name} (active=${p.isActive}) ${status}`);
    console.log(`  현재:    ${JSON.stringify(actual)}`);
    console.log(`  기대:    ${JSON.stringify(expected)}`);
    if (missing.length) {
      console.log(`  ❌ 누락: ${JSON.stringify(missing)}  ← 사용자가 차단됨`);
      issueCount++;
    }
    if (unknown.length) {
      console.log(`  ⚠️  미지의 feature: ${JSON.stringify(unknown)}  ← 데드코드`);
      issueCount++;
    }
    if (legacy.length) {
      console.log(`  ℹ️  레거시 (무해, 게이팅 안 됨): ${JSON.stringify(legacy)}`);
    }
    if (extra.length) {
      console.log(`  ℹ️  기대 외 추가: ${JSON.stringify(extra)}  ← 의도된 확장이면 EXPECTED 갱신`);
    }
    console.log('');
  }

  console.log('─'.repeat(60));
  if (issueCount === 0) {
    console.log('✅ 모든 플랜 정상');
  } else {
    console.log(`⚠️  ${issueCount}건 이슈 발견 — fix-plan-features.ts 실행 권장`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => prisma.$disconnect());
