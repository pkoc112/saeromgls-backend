import { Controller, Get, Headers, Logger, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import * as Sentry from '@sentry/node';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { PrismaService } from '../prisma/prisma.service';
import { IncentivesService } from '../incentives/incentives.service';
import { InvoicesService } from '../invoices/invoices.service';

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
    private readonly invoicesService: InvoicesService,
  ) {}

  private assertCronAuth(authHeader?: string): void {
    const secret = process.env.CRON_SECRET;
    // 2026-06 (A-Z 리뷰 P2-9): NODE_ENV뿐 아니라 VERCEL_ENV='production'도 체크
    const isProd =
      process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
    if (isProd) {
      if (!secret) {
        this.logger.error('CRON_SECRET not configured in production');
        throw new UnauthorizedException('Cron secret not configured');
      }
      if (authHeader !== `Bearer ${secret}`) {
        throw new UnauthorizedException('Invalid cron secret');
      }
    }
  }

  /**
   * 2026-06 (A-Z 리뷰 P1-3): cron 핸들러 공통 실행 래퍼.
   * - 멱등 작업은 실패 시 재시도 (max 3회, 지수 백오프)
   * - 최종 실패 시 Sentry 알림 + AdminActivityLog 기록 (silent 실패 방지)
   * Vercel Cron은 HTTP 500을 받아도 자동 재시도 안 함 → 앱 레벨에서 처리.
   */
  private async runCronJob<T>(
    jobName: string,
    fn: () => Promise<T>,
    opts: { idempotent?: boolean; maxRetries?: number } = {},
  ): Promise<T> {
    const { idempotent = false, maxRetries = idempotent ? 3 : 1 } = opts;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn();
        if (attempt > 1) {
          this.logger.log(`Cron ${jobName} succeeded on attempt ${attempt}`);
        }
        return result;
      } catch (err) {
        lastErr = err;
        this.logger.warn(`Cron ${jobName} attempt ${attempt}/${maxRetries} failed: ${err}`);
        if (attempt < maxRetries) {
          // 지수 백오프 (10s, 20s, ...)
          await new Promise((r) => setTimeout(r, 10000 * attempt));
        }
      }
    }
    // 최종 실패 — Sentry + 감사 로그
    try {
      Sentry.captureException(lastErr, {
        level: 'error',
        tags: { cron_job: jobName },
      });
    } catch { /* Sentry 미설정이어도 흐름 유지 */ }
    try {
      await this.prisma.adminActivityLog.create({
        data: {
          actorWorkerId: 'SYSTEM',
          actionType: 'CRON_FAILED',
          targetType: 'CRON',
          targetId: jobName,
          metadata: JSON.stringify({
            error: lastErr instanceof Error ? lastErr.message : String(lastErr),
            at: new Date().toISOString(),
          }),
        },
      });
    } catch { /* 감사 로그 실패도 무시 */ }
    this.logger.error(`Cron ${jobName} FINAL FAILURE after ${maxRetries} attempts: ${lastErr}`);
    throw lastErr;
  }

  @Get('subscription-check')
  @ApiOperation({
    summary: '구독 자동 전이 체크 (Trial→Expired, Active→PastDue, PastDue→Suspended, 인보이스 연체)',
  })
  async subscriptionCheck(@Headers('authorization') auth?: string) {
    this.assertCronAuth(auth);
    return this.runCronJob('subscription-check', async () => {
      const trialResult = await this.subscriptionsService.checkTrialExpirations();
      // P1-5a: 결제 기간 만료된 ACTIVE → PAST_DUE (기존엔 조회 시점에만 전이돼 미납 자동진행 안 됨)
      const activePastDueResult = await this.subscriptionsService.checkActivePastDue();
      const pastDueResult = await this.subscriptionsService.checkPastDueSuspensions();
      // P1-5b: 납기 지난 발행(ISSUED) 인보이스 → OVERDUE
      const overdueResult = await this.invoicesService.checkOverdue();
      this.logger.log(
        `Subscription cron: trial=${trialResult.processed}, activePastDue=${activePastDueResult.processed}, suspended=${pastDueResult.processed}, overdue=${overdueResult.markedOverdue}`,
      );
      return {
        timestamp: new Date().toISOString(),
        trialExpired: trialResult,
        activePastDue: activePastDueResult,
        pastDueSuspended: pastDueResult,
        invoicesOverdue: overdueResult,
      };
    }, { idempotent: true });
  }

  @Get('invoice-generate')
  @ApiOperation({
    summary: '매월 1일 — ACTIVE 구독 대상 월간 인보이스 자동 생성 (P1-5b)',
  })
  async invoiceGenerate(@Headers('authorization') auth?: string) {
    this.assertCronAuth(auth);
    return this.runCronJob('invoice-generate', async () => {
      const result = await this.invoicesService.generateMonthlyInvoices();
      this.logger.log(
        `Invoice cron: month=${result.monthLabel}, generated=${result.generated}, skipped=${result.skipped}`,
      );
      return result;
    }, { idempotent: true });
  }

  @Get('data-retention-purge')
  @ApiOperation({
    summary: '데이터 보관/파기 정책 — 작업기록 3년/감사로그 1년/로그인이력 1년',
  })
  async dataRetentionPurge(@Headers('authorization') auth?: string) {
    this.assertCronAuth(auth);
    return this.runCronJob(
      'data-retention-purge',
      async () => {
        const now = new Date();
        const purgeStats = {
          timestamp: now.toISOString(),
          workItemsDeleted: 0,
          auditLogsDeleted: 0,
          adminActivityLogsDeleted: 0,
          loginHistoryDeleted: 0,
          refreshTokensDeleted: 0,
          piiFinalizedCount: 0,
          heatCheckAlertsDeleted: 0,
          heatHourlyRecordsDeleted: 0,
          mobileDiagnosticsDeleted: 0,
          verificationCodesDeleted: 0,
          errors: [] as string[],
        };

        // ★ 단계별 격리: 한 단계 실패(스키마 드리프트 P2021/타임아웃)가 나머지 파기를
        //   막지 않도록 각 step을 독립 try/catch로 감싸고 errors[]에 누적 + step별 Sentry emit.
        const runStep = async (label: string, fn: () => Promise<void>) => {
          try {
            await fn();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            purgeStats.errors.push(`${label}: ${msg}`);
            this.logger.error(`[purge] ${label} 실패: ${msg}`);
            try {
              Sentry.captureException(e, {
                level: 'error',
                tags: { cron_job: 'data-retention-purge', step: label },
              });
            } catch {
              /* Sentry 미설정 무시 */
            }
          }
        };

        const threeYearsAgo = new Date(now);
        threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
        const oneYearAgo = new Date(now);
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        const sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const ninetyDaysAgo = new Date(now);
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

        // 작업 기록 3년 — id 청크로 배치 삭제(대량 IN/함수 타임아웃 방지) +
        // InspectionRecord(필수참조=Restrict) 선삭제로 FK 롤백 영구실패 방지(함정 #18).
        // WorkAssignment(Cascade)·AuditLog(SetNull)은 DB가 처리하나 명시 정리.
        await runStep('workItems', async () => {
          const oldWorkItems = await this.prisma.workItem.findMany({
            where: { startedAt: { lt: threeYearsAgo } },
            select: { id: true },
          });
          const allIds = oldWorkItems.map((w) => w.id);
          const CHUNK = 1000;
          for (let i = 0; i < allIds.length; i += CHUNK) {
            const ids = allIds.slice(i, i + CHUNK);
            await this.prisma.$transaction(async (tx) => {
              await tx.inspectionRecord.deleteMany({
                where: { sourceWorkItemId: { in: ids } },
              });
              await tx.workAssignment.deleteMany({
                where: { workItemId: { in: ids } },
              });
              await tx.auditLog.deleteMany({ where: { workItemId: { in: ids } } });
              const r = await tx.workItem.deleteMany({ where: { id: { in: ids } } });
              purgeStats.workItemsDeleted += r.count;
            });
          }
        });

        await runStep('auditLogs', async () => {
          const r = await this.prisma.auditLog.deleteMany({
            where: { createdAt: { lt: oneYearAgo } },
          });
          purgeStats.auditLogsDeleted = r.count;
        });
        await runStep('adminActivityLogs', async () => {
          const r = await this.prisma.adminActivityLog.deleteMany({
            where: { createdAt: { lt: oneYearAgo } },
          });
          purgeStats.adminActivityLogsDeleted = r.count;
        });
        await runStep('loginHistory', async () => {
          const r = await this.prisma.loginHistory.deleteMany({
            where: { createdAt: { lt: oneYearAgo } },
          });
          purgeStats.loginHistoryDeleted = r.count;
        });
        await runStep('refreshTokens', async () => {
          const r = await this.prisma.refreshToken.deleteMany({
            where: {
              OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: sevenDaysAgo } }],
            },
          });
          purgeStats.refreshTokensDeleted = r.count;
        });
        await runStep('heatCheckAlerts', async () => {
          const r = await this.prisma.heatCheckAlert.deleteMany({
            where: { createdAt: { lt: threeYearsAgo } },
          });
          purgeStats.heatCheckAlertsDeleted = r.count;
        });
        await runStep('heatHourlyRecords', async () => {
          const r = await this.prisma.heatHourlyRecord.deleteMany({
            where: { createdAt: { lt: threeYearsAgo } },
          });
          purgeStats.heatHourlyRecordsDeleted = r.count;
        });
        await runStep('mobileDiagnostics', async () => {
          const r = await this.prisma.mobileDiagnostic.deleteMany({
            where: { createdAt: { lt: ninetyDaysAgo } },
          });
          purgeStats.mobileDiagnosticsDeleted = r.count;
        });
        await runStep('verificationCodes', async () => {
          const r = await this.prisma.verificationCode.deleteMany({
            where: { expiresAt: { lt: now } },
          });
          purgeStats.verificationCodesDeleted = r.count;
        });

        // 90일 경과 INACTIVE 계정 PII 최종 익명화 — 건별 try/catch로 한 건 실패가
        // 나머지 센터 탈퇴자 익명화를 막지 않도록 격리.
        await runStep('piiFinalize', async () => {
          const inactiveOld = await this.prisma.worker.findMany({
            where: { status: 'INACTIVE', updatedAt: { lt: ninetyDaysAgo } },
            select: { id: true, name: true },
          });
          for (const w of inactiveOld) {
            if (w.name && !w.name.startsWith('탈퇴회원-')) {
              try {
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
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                purgeStats.errors.push(`piiFinalize(${w.id.slice(0, 8)}): ${msg}`);
                this.logger.error(`[purge] PII 익명화 실패 ${w.id}: ${msg}`);
              }
            }
          }
        });

        // 감사 기록 (errors 포함)
        await runStep('audit-record', async () => {
          await this.prisma.adminActivityLog.create({
            data: {
              actorWorkerId: 'SYSTEM',
              actionType: 'DATA_RETENTION_PURGE',
              targetType: 'CRON',
              targetId: 'monthly-purge',
              metadata: JSON.stringify(purgeStats),
            },
          });
        });

        if (purgeStats.errors.length > 0) {
          this.logger.error(
            `Data retention purge completed WITH ${purgeStats.errors.length} errors: ${JSON.stringify(purgeStats.errors)}`,
          );
        } else {
          this.logger.log(
            `Data retention purge completed: ${JSON.stringify(purgeStats)}`,
          );
        }
        return purgeStats;
      },
      { idempotent: true },
    );
  }

  @Get('incentive-monthly-shadow')
  @ApiOperation({
    summary:
      '매월 1일 03:00 KST — 전월(YYYY-MM) 인센티브 ScoreRun 자동 생성 (모든 사이트)',
  })
  async incentiveMonthlyShadow(@Headers('authorization') auth?: string) {
    this.assertCronAuth(auth);
    return this.runCronJob('incentive-monthly-shadow', async () => {
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
    }, { idempotent: true });
  }

  @Get('incentive-auto-finalize')
  @ApiOperation({
    summary:
      '매일 04:00 KST — 7일 이상 FROZEN + 미해결 이의 0건인 ScoreRun 자동 FINALIZE',
  })
  async incentiveAutoFinalize(@Headers('authorization') auth?: string) {
    this.assertCronAuth(auth);
    return this.runCronJob('incentive-auto-finalize', async () => {
      const result = await this.incentivesService.autoFinalizeStaleFrozenRuns(7);
      this.logger.log(
        `Auto-finalize cron: candidates=${result.candidates}, finalized=${result.finalized}, skipped=${result.skipped.length}`,
      );
      return result;
    }, { idempotent: true });
  }
}
