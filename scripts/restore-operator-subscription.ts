/**
 * 운영자 본인 사이트(대구) 구독을 ACTIVE로 영구 복원.
 *
 * 배경:
 *   - 2026-05-12에 자동 갱신 결제 실패로 PAST_DUE 전환됨
 *   - 외부 결제 시스템 미연동 단계라 정상 결제 안 됨
 *   - 운영자 본인 사이트는 외부 고객 받기 전까지 PRO 영구 유지가 정책
 *
 * 처리:
 *   - status: PAST_DUE → ACTIVE
 *   - endedAt: 1년 후 (2027-05-14) — subscription-check cron이 다시 만료 처리 못 하게
 *   - 사이트별 처리, 다른 사이트는 정상 결제 로직 유지
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SITE_ID = '496e3166-8919-4699-809f-e698fff6446a'; // 대구 물류센터

async function main() {
  const before = await prisma.subscription.findFirst({
    where: { siteId: SITE_ID },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!before) {
    console.log('❌ 구독 없음 — 새로 생성해야 함. 중단.');
    process.exit(1);
  }

  console.log('\n=== 변경 전 ===');
  console.log(`  플랜: ${before.plan?.code}`);
  console.log(`  상태: ${before.status}`);
  console.log(`  currentPeriodEnd: ${before.currentPeriodEnd?.toISOString() ?? '-'}`);

  // 1년 후 (2027-05-14 KST 자정 = 2027-05-13T15:00:00Z)
  // subscription-check cron이 currentPeriodEnd 기반으로 PAST_DUE 판단하므로
  // 이 값을 1년 후로 늘려 자동 만료 방지.
  const oneYearLater = new Date();
  oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
  oneYearLater.setUTCHours(15, 0, 0, 0);

  const updated = await prisma.subscription.update({
    where: { id: before.id },
    data: {
      status: 'ACTIVE',
      currentPeriodEnd: oneYearLater,
    },
  });

  console.log('\n=== 변경 후 ===');
  console.log(`  상태: ${updated.status} ✅`);
  console.log(`  currentPeriodEnd: ${updated.currentPeriodEnd?.toISOString()} (1년 후)`);
  console.log('\n✅ 운영자 본인 사이트 PRO 구독 영구 복원 완료');
  console.log('   다음 결제 주기에도 자동 PAST_DUE 안 됨');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => prisma.$disconnect());
