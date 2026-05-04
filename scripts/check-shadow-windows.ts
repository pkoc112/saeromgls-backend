/**
 * SHADOW 정책 28일 윈도우 점검 (read-only).
 *
 * 각 SHADOW 정책의 effectiveFrom으로부터 며칠 경과했는지,
 * ACTIVE 승격이 가능한 상태인지 보고한다.
 * 절대 mutation 금지.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const MIN_DAYS = 28;

async function main() {
  const policies = await prisma.policyVersion.findMany({
    where: { status: 'SHADOW' },
    orderBy: [{ siteId: 'asc' }, { track: 'asc' }],
    include: { site: { select: { name: true } } },
  });

  if (policies.length === 0) {
    console.log('SHADOW 상태 정책 없음.');
    return;
  }

  console.log(`\n=== SHADOW 정책 ${policies.length}건 ===\n`);

  const now = Date.now();
  let promotable = 0;
  let blocked = 0;
  let missingEffectiveFrom = 0;

  for (const p of policies) {
    const start = p.effectiveFrom;
    if (!start) {
      console.log(
        `[${p.site?.name ?? '?'}] ${p.track?.padEnd(15)} "${p.name}"  ⚠️  effectiveFrom 없음 ` +
        `→ force=true + reason 으로만 승격 가능`,
      );
      missingEffectiveFrom++;
      continue;
    }

    const elapsedMs = now - start.getTime();
    const elapsedDays = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
    const remainingDays = MIN_DAYS - elapsedDays;

    if (elapsedDays >= MIN_DAYS) {
      console.log(
        `[${p.site?.name ?? '?'}] ${p.track?.padEnd(15)} "${p.name}"  ` +
        `✅ ${elapsedDays}일째 — 승격 가능 (effectiveFrom=${start.toISOString().split('T')[0]})`,
      );
      promotable++;
    } else {
      console.log(
        `[${p.site?.name ?? '?'}] ${p.track?.padEnd(15)} "${p.name}"  ` +
        `⏳ ${elapsedDays}일째 — ${remainingDays}일 더 필요 ` +
        `(effectiveFrom=${start.toISOString().split('T')[0]})`,
      );
      blocked++;
    }
  }

  console.log('\n─'.repeat(30));
  console.log(`승격 가능:        ${promotable}건`);
  console.log(`28일 미만:        ${blocked}건`);
  console.log(`effectiveFrom 없음: ${missingEffectiveFrom}건`);

  if (missingEffectiveFrom > 0) {
    console.log(
      '\n⚠️  effectiveFrom이 비어있는 정책은 SHADOW 진입 시 자동 스탬프 로직 ' +
      '도입 이전에 만들어진 것. 승격 시 force=true 필요.',
    );
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => prisma.$disconnect());
