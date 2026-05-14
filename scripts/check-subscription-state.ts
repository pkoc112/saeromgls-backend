/**
 * 대구 사이트 구독 상태 진단 (read-only).
 * PRO 플랜인데 일부 기능이 잠겨 보이는 원인 추적용.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SITE_ID = '496e3166-8919-4699-809f-e698fff6446a'; // 대구 물류센터

async function main() {
  // 1. 사이트의 최신 구독
  const sub = await prisma.subscription.findFirst({
    where: { siteId: SITE_ID },
    include: { plan: true, site: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });

  console.log('\n=== 대구 사이트 최신 구독 ===');
  if (!sub) {
    console.log('  ❌ 구독 없음 → EntitlementGuard가 FREE 플랜 features만 허용');
    const freePlan = await prisma.plan.findUnique({ where: { code: 'FREE' } });
    console.log(`  FREE features: ${JSON.stringify(freePlan?.features ?? [])}`);
    return;
  }

  console.log(`  사이트: ${sub.site?.name}`);
  console.log(`  플랜: ${sub.plan?.code} (${sub.plan?.name})`);
  console.log(`  상태: ${sub.status}`);
  console.log(`  생성: ${sub.createdAt.toISOString().split('T')[0]}`);
  console.log(`  trialEndsAt: ${sub.trialEndsAt?.toISOString().split('T')[0] ?? '-'}`);
  console.log(`  currentPeriodEnd: ${sub.currentPeriodEnd?.toISOString().split('T')[0] ?? '-'}`);
  console.log(`  features: ${JSON.stringify(sub.plan?.features ?? [])}`);

  // EntitlementGuard 차단 사유 시뮬레이션
  console.log('\n=== EntitlementGuard 진단 ===');
  const isActiveOrTrial = ['ACTIVE', 'TRIAL'].includes(sub.status);
  if (!isActiveOrTrial) {
    console.log(`  ❌ 상태가 ACTIVE/TRIAL 아님 (현재: ${sub.status}) → 모든 @Feature() API 403`);
  } else {
    console.log(`  ✅ 상태 OK`);
  }
  if (sub.status === 'TRIAL' && sub.trialEndsAt && sub.trialEndsAt < new Date()) {
    console.log(`  ❌ TRIAL 만료됨 (${sub.trialEndsAt.toISOString().split('T')[0]}) → 모든 @Feature() API 403`);
  }

  // 2. 운영자(권성훈) 정보
  const owner = await prisma.worker.findFirst({
    where: { siteId: SITE_ID, role: 'ADMIN', email: 'gsh3387@naver.com' },
    select: { id: true, name: true, role: true, siteId: true, status: true },
  });
  console.log('\n=== 운영자 (권성훈) ===');
  console.log(`  ${JSON.stringify(owner)}`);
  if (!owner) {
    console.log('  ⚠️  찾을 수 없음 — 이메일 확인 필요');
  } else if (!owner.siteId) {
    console.log('  ❌ siteId 없음 → 모든 @Feature() API에서 "소속 사업장 없음" 403');
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => prisma.$disconnect());
