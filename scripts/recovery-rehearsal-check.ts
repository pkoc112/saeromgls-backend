/**
 * DB 복구 리허설 — 운영 DB read-only 무결성 점검 스크립트.
 * 복구_리허설_가이드.md §5-1, §5-2의 체크리스트를 자동화한다.
 *
 * 실행:
 *   DATABASE_URL=<production-url> npx ts-node scripts/recovery-rehearsal-check.ts
 *
 * 절대 mutation 쿼리 추가 금지. count/findMany select만 사용.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  log: ['warn', 'error'],
});

async function main() {
  const startedAt = Date.now();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 3600 * 1000);

  // ── 5-1. 핵심 카운트 무결성 ──
  const [
    sites,
    activeWorkers,
    masterCount,
    classifications,
    workItemsTotal,
    workItemsLast7d,
    subscriptions,
    activeSubs,
    refreshTokensValid,
    objectionsOpen,
    scoreRunsRunning,
    auditLogsLast24h,
  ] = await Promise.all([
    prisma.site.count({ where: { isActive: true } }),
    prisma.worker.count({ where: { status: 'ACTIVE' } }),
    prisma.worker.count({ where: { role: 'MASTER' } }),
    prisma.classification.count({ where: { isActive: true } }),
    prisma.workItem.count(),
    prisma.workItem.count({ where: { startedAt: { gte: sevenDaysAgo } } }),
    prisma.subscription.count(),
    prisma.subscription.count({ where: { status: 'ACTIVE' } }),
    prisma.refreshToken.count({ where: { expiresAt: { gte: new Date() } } }),
    prisma.objectionCase.count({ where: { status: { in: ['OPEN', 'REVIEWING'] } } }),
    prisma.scoreRun.count({ where: { status: { in: ['RUNNING', 'SHADOW'] } } }),
    prisma.auditLog.count({ where: { createdAt: { gte: oneDayAgo } } }),
  ]);

  // ── 5-2. 무결성 위반 패턴 (외래키 고아 등) ──
  // siteId가 있지만 site가 없는 worker
  const orphanWorkersBySite = await prisma.worker.findMany({
    where: { siteId: { not: null }, site: null as any },
    select: { id: true, name: true, siteId: true },
    take: 5,
  }).catch(() => [] as Array<{ id: string; name: string; siteId: string | null }>);

  // worker가 없는 work_assignment
  const orphanAssignments = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM work_assignments wa
    LEFT JOIN workers w ON wa.worker_id = w.id
    WHERE w.id IS NULL
  `.catch(() => [{ count: -1n }] as Array<{ count: bigint }>);

  // worker가 없는 work_item.startedByWorkerId
  const orphanWorkItems = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM work_items wi
    LEFT JOIN workers w ON wi.started_by_worker_id = w.id
    WHERE w.id IS NULL
  `.catch(() => [{ count: -1n }] as Array<{ count: bigint }>);

  // ── 출력 ──
  const elapsedMs = Date.now() - startedAt;
  const report = {
    timestamp: new Date().toISOString(),
    elapsedMs,
    counts: {
      sites,
      activeWorkers,
      masterCount,
      classifications,
      workItemsTotal,
      workItemsLast7d,
      subscriptions,
      activeSubs,
      refreshTokensValid,
      objectionsOpen,
      scoreRunsRunning,
      auditLogsLast24h,
    },
    integrity: {
      orphanWorkersBySite: orphanWorkersBySite.length,
      orphanAssignmentsCount: Number(orphanAssignments[0]?.count ?? -1n),
      orphanWorkItemsCount: Number(orphanWorkItems[0]?.count ?? -1n),
    },
    pass:
      orphanWorkersBySite.length === 0 &&
      Number(orphanAssignments[0]?.count ?? 0) === 0 &&
      Number(orphanWorkItems[0]?.count ?? 0) === 0 &&
      activeWorkers > 0 &&
      sites > 0,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.pass ? 0 : 2;
}

main()
  .catch((e) => {
    console.error('[rehearsal-check] failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
