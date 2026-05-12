/**
 * SHADOW 정책 4개 effectiveFrom 30일 연장 + v3.1 freeze 메모 추가.
 *
 * 2026-05-12 Deep Research 진단(D등급) 결과:
 *   - 트랙별 nominal max 정규화 v3.1 적용
 *   - 검수 low-defect 패널티 제거
 *   - MIN_DAYS_WORKED 3 → 8
 *   ↑ 세 변경 후 30일 추가 SHADOW 운영 → 2026-06-11 자연 승격 가능
 *
 * 이 스크립트는 idempotent. effectiveFrom을 오늘 + 30일로 갱신하고
 * description에 freeze 메모를 prepend.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SITE_ID = '496e3166-8919-4699-809f-e698fff6446a'; // 대구 물류센터
const FREEZE_MEMO_TAG = '[v3.1 freeze 2026-05-12]';

async function main() {
  const shadows = await prisma.policyVersion.findMany({
    where: { siteId: SITE_ID, status: 'SHADOW' },
    select: { id: true, name: true, track: true, effectiveFrom: true, description: true },
  });

  if (shadows.length === 0) {
    console.log('SHADOW 정책 없음. 종료.');
    return;
  }

  console.log(`\n=== SHADOW 정책 ${shadows.length}건 → effectiveFrom 30일 재시작 ===\n`);

  // 오늘 자정 (KST) 기준으로 effectiveFrom 재설정
  const todayKstMidnight = new Date();
  todayKstMidnight.setUTCHours(15, 0, 0, 0); // 00:00 KST = 15:00 UTC 전날
  if (todayKstMidnight > new Date()) {
    todayKstMidnight.setDate(todayKstMidnight.getDate() - 1);
  }

  for (const s of shadows) {
    const existingDesc = s.description || '';
    if (existingDesc.includes(FREEZE_MEMO_TAG)) {
      console.log(`[${s.track}] 이미 freeze 메모 있음, effectiveFrom만 갱신`);
    }

    const newDesc = existingDesc.includes(FREEZE_MEMO_TAG)
      ? existingDesc
      : `${FREEZE_MEMO_TAG} 트랙별 nominal max 정규화 + 검수 low-defect 제거 + MIN_DAYS 3→8 적용. 30일 추가 SHADOW 후 자연 승격.\n\n${existingDesc}`;

    await prisma.policyVersion.update({
      where: { id: s.id },
      data: {
        effectiveFrom: todayKstMidnight,
        description: newDesc,
      },
    });

    console.log(
      `[${s.track}] "${s.name}" effectiveFrom 갱신:\n` +
        `  이전: ${s.effectiveFrom?.toISOString().split('T')[0] ?? '-'}\n` +
        `  현재: ${todayKstMidnight.toISOString().split('T')[0]}\n` +
        `  자연 승격 가능 시점: ${new Date(todayKstMidnight.getTime() + 28 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}`,
    );
  }

  console.log('\n─'.repeat(40));
  console.log(`✅ ${shadows.length}건 처리 완료`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => prisma.$disconnect());
