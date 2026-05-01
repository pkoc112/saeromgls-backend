import { Controller, Get, Headers, Logger, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { PrismaService } from '../prisma/prisma.service';
import { IncentivesService } from '../incentives/incentives.service';

/**
 * Vercel Cron 핸들러 — 외부에서 주기적으로 호출되어 자동 작업 수행
 *
 * 보호:
 * - Vercel Cron 호출은 Authorization: Bearer ${CRON_SECRET} 헤더가 자동 첨부됨
 * - CRON_SECRET 환경변수 미설정 시(개발) 누구나 호출 가능 — 프로덕션에선 반드시 설정
 *
 * 스케줄(KST 기준 — vercel.json 의 cron schedule 은 UTC):
 * - 매일 03:00 KST (= 18:00 UTC) → subscription-check
 * - 매월 1일 02:00 KST (= 17:00 UTC 전날) → data-retention-purge
 */
@ApiTags('Cron')
@Controller('cron')
export class CronController {
  private readonly logger = new Logger(CronController.name);

  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    private readonly prisma: PrismaService,
    private readonly incentivesService: IncentivesService,
  ) {}

  private assertCronAuth(authHeader?: string): void {
    const secret = process.env.CRON_SECRET;
    if (process.env.NODE_ENV === 'production') {
      if (!secret) {
        this.logger.error('CRON_SECRET not configured in production');
        throw new UnauthorizedException('Cron secret not configured');
      }
      if (authHeader !== `Bearer ${secret}`) {
        throw new UnauthorizedException('Invalid cron secret');
      }
    }
  }

  @Get('subscription-check')
  @ApiOperation({
    summary: '구독 자동 전이 체크 (Trial 만료, Past_Due → Suspended)',
  })
  async subscriptionCheck(@Headers('authorization') auth?: string) {
    this.assertCronAuth(auth);
    const trialResult = await this.subscriptionsService.checkTrialExpirations();
    const pastDueResult = await this.subscriptionsService.checkPastDueSuspensions();
    this.logger.log(
      `Subscription cron: trial=${trialResult.processed}, suspended=${pastDueResult.processed}`,
    );
    return {
      timestamp: new Date().toISOString(),
      trialExpired: trialResult,
      pastDueSuspended: pastDueResult,
    };
  }

  @Get('data-retention-purge')
  @ApiOperation({
    summary: '데이터 보관/파기 정책 — 작업기록 3년/감사로그 1년/로그인이력 1년',
  })
  async dataRetentionPurge(@Headers('authorization') auth?: string) {
    this.assertCronAuth(auth);
    const now = new Date();
    const purgeStats = {
      timestamp: now.toISOString(),
      workItemsDeleted: 0,
      auditLogsDeleted: 0,
      adminActivityLogsDeleted: 0,
      loginHistoryDeleted: 0,
      refreshTokensDeleted: 0,
      piiFinalizedCount: 0,
    };

    try {
      // 작업 기록 3년 경과
      const threeYearsAgo = new Date(now);
      threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
      const oldWorkItems = await this.prisma.workItem.findMany({
        where: { startedAt: { lt: threeYearsAgo } },
        select: { id: true },
      });
      const ids = oldWorkItems.map((w) => w.id);
      if (ids.length > 0) {
        await this.prisma.$transaction(async (tx) => {
          await tx.workAssignment.deleteMany({ where: { workItemId: { in: ids } } });
          await tx.auditLog.deleteMany({ where: { workItemId: { in: ids } } });
          const r = await tx.workItem.deleteMany({ where: { id: { in: ids } } });
          purgeStats.workItemsDeleted = r.count;
        });
      }

      // 감사 로그 1년 경과
      const oneYearAgo = new Date(now);
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      const auditResult = await this.prisma.auditLog.deleteMany({
        where: { createdAt: { lt: oneYearAgo } },
      });
      purgeStats.auditLogsDeleted = auditResult.count;
      const adminActResult = await this.prisma.adminActivityLog.deleteMany({
        where: { createdAt: { lt: oneYearAgo } },
      });
      purgeStats.adminActivityLogsDeleted = adminActResult.count;
      const loginResult = await this.prisma.loginHistory.deleteMany({
        where: { createdAt: { lt: oneYearAgo } },
      });
      purgeStats.loginHistoryDeleted = loginResult.count;

      // 만료된 refresh token
      const refreshResult = await this.prisma.refreshToken.deleteMany({
        where: { expiresAt: { lt: now } },
      });
      purgeStats.refreshTokensDeleted = refreshResult.count;

      // 90일 경과 INACTIVE 계정 PII 최종 삭제
      const ninetyDaysAgo = new Date(now);
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const inactiveOld = await this.prisma.worker.findMany({
        where: { status: 'INACTIVE', updatedAt: { lt: ninetyDaysAgo } },
        select: { id: true, name: true },
      });
      for (const w of inactiveOld) {
        if (w.name && !w.name.startsWith('탈퇴회원-')) {
          const shortHash = w.id.slice(0, 8);
          await this.prisma.worker.update({
            where: { id: w.id },
            data: {
              name: `탈퇴회원-${shortHash}`,
              phone: null,
              passwordHash: null,
              pin: '',
            },
          });
          purgeStats.piiFinalizedCount++;
        }
      }

      // 감사 기록
      await this.prisma.adminActivityLog.create({
        data: {
          actorWorkerId: 'SYSTEM',
          actionType: 'DATA_RETENTION_PURGE',
          targetType: 'CRON',
          targetId: 'monthly-purge',
          metadata: JSON.stringify(purgeStats),
        },
      });

      this.logger.log(`Data retention purge completed: ${JSON.stringify(purgeStats)}`);
      return purgeStats;
    } catch (err) {
      this.logger.error(`Data retention purge failed: ${err}`);
      throw err;
    }
  }

  @Get('incentive-monthly-shadow')
  @ApiOperation({
    summary:
      '매월 1일 03:00 KST — 전월(YYYY-MM) 인센티브 ScoreRun 자동 생성 (모든 사이트)',
  })
  async incentiveMonthlyShadow(@Headers('authorization') auth?: string) {
    this.assertCronAuth(auth);
    // 전월(YYYY-MM) 계산 — KST 기준
    const now = new Date();
    const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const target = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth() - 1, 1));
    const month = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}`;

    const result = await this.incentivesService.runMonthlyShadowForAllSites(month);
    this.logger.log(
      `Monthly shadow cron: month=${month}, runs=${result.totalRuns}, sites=${result.sitesProcessed}`,
    );
    return result;
  }

  @Get('incentive-auto-finalize')
  @ApiOperation({
    summary:
      '매일 04:00 KST — 7일 이상 FROZEN + 미해결 이의 0건인 ScoreRun 자동 FINALIZE',
  })
  async incentiveAutoFinalize(@Headers('authorization') auth?: string) {
    this.assertCronAuth(auth);
    const result = await this.incentivesService.autoFinalizeStaleFrozenRuns(7);
    this.logger.log(
      `Auto-finalize cron: candidates=${result.candidates}, finalized=${result.finalized}, skipped=${result.skipped.length}`,
    );
    return result;
  }
}
