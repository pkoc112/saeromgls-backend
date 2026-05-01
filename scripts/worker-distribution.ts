/**
 * worker 분포 조회 — 역할/상태/이메일 보유 여부별 카운트.
 * 키오스크 운영 모델에서 email 암호화 영향 범위 산정용.
 * 절대 mutation 금지. read-only.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['warn', 'error'] });

async function main() {
  const all = await prisma.worker.findMany({
    select: {
      id: true,
      role: true,
      status: true,
      email: true,
      employeeCode: true,
      jobTrack: true,
      siteId: true,
      // 이름은 노출하지 않고 마스킹
    },
  });

  const byRoleStatus = all.reduce<Record<string, number>>((acc, w) => {
    const k = `${w.role}/${w.status}`;
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  const withEmail = all.filter((w) => !!w.email).length;
  const withoutEmail = all.length - withEmail;
  const byJobTrack = all.reduce<Record<string, number>>((acc, w) => {
    const k = w.jobTrack || '(none)';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const bySite = all.reduce<Record<string, number>>((acc, w) => {
    const k = w.siteId || '(no-site)';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  // email 보유자의 역할 분포 — "재로그인 필요" 영향 받는 실제 사용자
  const emailHoldersByRole = all
    .filter((w) => !!w.email)
    .reduce<Record<string, number>>((acc, w) => {
      acc[w.role] = (acc[w.role] || 0) + 1;
      return acc;
    }, {});

  // PIN 만 있는 (email 없는) 작업자 = 태블릿 키오스크 사용자
  const pinOnlyByRole = all
    .filter((w) => !w.email)
    .reduce<Record<string, number>>((acc, w) => {
      acc[w.role] = (acc[w.role] || 0) + 1;
      return acc;
    }, {});

  console.log(
    JSON.stringify(
      {
        total: all.length,
        byRoleStatus,
        emailStats: {
          withEmail,
          withoutEmail,
          emailHoldersByRole,
          pinOnlyByRole,
        },
        byJobTrack,
        bySite,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error('failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
