import { Body, Controller, Get, Headers, Logger, Post, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import * as Sentry from '@sentry/node';
import { Prisma } from '@prisma/client';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { PrismaService } from '../prisma/prisma.service';
import { IncentivesService } from '../incentives/incentives.service';
import { InvoicesService } from '../invoices/invoices.service';
import { NotificationsService } from '../common/notifications/notifications.service';
import { HeatAlertsService } from '../heat-alerts/heat-alerts.service';
import { CustomerOpsService } from '../customer-ops/customer-ops.service';
import { ReportsService } from '../reports/reports.service';
import { BackupReportDto } from './dto/backup-report.dto';
import {
  BACKUP_JOB_STATUS,
  BACKUP_JOB_TYPE,
  BACKUP_STALE_HOURS,
  BackupHeartbeat,
  formatBytes,
  loadBackupHeartbeat,
} from '../common/utils/backup-heartbeat';
import { resolveSystemActorId, systemMetadata } from '../common/utils/system-actor';

/** #49 백업 지연 경고 발송 기록 actionType (AdminActivityLog) — 하루 1회 판정 근거 */
const BACKUP_STALE_ALERT_ACTION = 'BACKUP_STALE_ALERT';

/** 구독 종료 상태 — 고객 발송 제외 (MASTER 롤업에는 상태만 표기) */
const CUSTOMER_EXCLUDED_SUBSCRIPTION_STATUSES = ['EXPIRED', 'SUSPENDED', 'CANCELLED'];
/** PAUSED 작업을 종료 누락으로 간주하는 경과 시간 (1일) */
const STUCK_PAUSED_HOURS = 24;
/** 종료 누락 메일 표에 표시하는 최대 행 수 (초과분은 "외 N건") */
const STUCK_MAIL_MAX_ROWS = 100;
/** 웹 대시보드 기본 URL (auth/reports/customer-ops 와 동일 규칙) */
const webBaseUrl = () => process.env.WEB_BASE_URL || 'https://sae-work.com';

const TD_STYLE = 'border:1px solid #ddd;padding:6px 8px;vertical-align:top;';
const TH_STYLE = 'border:1px solid #ddd;padding:6px 8px;text-align:left;background:#f3f4f6;';

type CronSite = { id: string; name: string; code: string; createdAt: Date };
type SendCounter = { sent: number; skipped: number };
type MasterOutcome = 'sent' | 'skipped' | 'failed';
type SendOutcome = '발송' | '미발송(메일 미설정)' | '발송 실패';
/** #49 subscription-check 응답의 backupHeartbeat 항목 */
type BackupHeartbeatOutcome = {
  status: 'ok' | 'stale' | 'error';
  lastSuccessfulBackupAt: string | null;
  lastBackupStatus: string | null;
  ageHours: number | null;
  thresholdHours: number;
  alertSent: boolean;
  skipped?: string;
  mailId?: string;
  error?: string;
};

/**
 * Vercel Cron 핸들러 — 외부에서 주기적으로 호출되어 자동 작업 수행
 *
 * 보호:
 * - Vercel Cron 호출은 Authorization: Bearer ${CRON_SECRET} 헤더가 자동 첨부됨
 * - CRON_SECRET 환경변수 미설정 시(개발) 누구나 호출 가능 — 프로덕션에선 반드시 설정
 *
 * 스케줄(KST 기준 — vercel.json 의 cron schedule 은 UTC):
 * - 매일 03:00 KST (= 18:00 UTC) → subscription-check (+ 구독 만료 D-day 알림 + #49 백업 heartbeat 30h 경고)
 * - (스케줄 아님) POST backup-report → GitHub Actions db-backup.yml 이 성공/실패 시 호출 (#49, BackupJob 기록)
 * - 매일 04:00 KST (= 19:00 UTC) → incentive-auto-finalize
 * - 매일 06:00 KST (= 21:00 UTC 전날) → heat-forecast-notice
 * - 매일 09:30 KST (= 00:30 UTC) → ops-digest (MASTER 아침 운영 다이제스트)
 * - 매일 20:00 KST (= 11:00 UTC) → evening-notices (종료 누락 + 일일 요약)
 * - 매주 월 00:00 KST (= 일 15:00 UTC) → weekly-summary
 * - 매월 1일 02:00 KST (= 17:00 UTC 전날) → data-retention-purge
 * - 매월 1일 03:00 / 04:00 KST → incentive-monthly-shadow / invoice-generate
 *
 * 발송 크론 원칙:
 * - 센터별 try/catch (한 센터 실패가 나머지를 막지 않음)
 * - 발송이 센터별로 즉시 일어나는 작업은 idempotent:false (재시도 중복 발송 방지)
 * - 구독 EXPIRED/SUSPENDED/CANCELLED 센터는 고객 발송 제외, MASTER 롤업엔 포함
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
    private readonly notifications: NotificationsService,
    private readonly heatAlertsService: HeatAlertsService,
    private readonly customerOpsService: CustomerOpsService,
    private readonly reportsService: ReportsService,
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
      // actor_worker_id 는 workers FK — 'SYSTEM' 문자열은 FK 위반이라 MASTER 계정을 시스템 행위자로 사용
      const actor = await resolveSystemActorId(this.prisma);
      if (!actor) {
        this.logger.warn(`Cron ${jobName}: 시스템 행위자(MASTER) 없음 → CRON_FAILED 감사 기록 생략`);
      } else {
        await this.prisma.adminActivityLog.create({
          data: {
            actorWorkerId: actor,
            actionType: 'CRON_FAILED',
            targetType: 'CRON',
            targetId: jobName,
            metadata: systemMetadata({
              error: lastErr instanceof Error ? lastErr.message : String(lastErr),
              at: new Date().toISOString(),
            }),
          },
        });
      }
    } catch { /* 감사 로그 실패도 무시 */ }
    this.logger.error(`Cron ${jobName} FINAL FAILURE after ${maxRetries} attempts: ${lastErr}`);
    throw lastErr;
  }

  @Get('subscription-check')
  @ApiOperation({
    summary:
      '구독 자동 전이 체크 (Trial→Expired, Active→PastDue, PastDue→Suspended, 인보이스 연체) + 만료 D-day 알림',
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

      // #17 구독 만료 D-day 알림 — 전이가 모두 끝난 뒤 마지막에 호출.
      //   - notifyUpcomingExpirations 는 사이트별 try/catch 로 throw 하지 않지만, 알림 실패가
      //     전이 결과 반환을 막지 않도록 방어적으로 한 번 더 감쌈.
      //   - 이 라우트는 idempotent:true(재시도) 이나, 재시도는 위 전이 단계가 throw 할 때만
      //     일어나고(알림 도달 전) 알림 단계는 throw 하지 않으므로 중복 발송 없음.
      let expiryNotices: { sent: number; skipped: number; errors: string[] };
      try {
        expiryNotices = await this.subscriptionsService.notifyUpcomingExpirations();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`구독 만료 D-day 알림 실패 (전이 결과는 정상 반환): ${msg}`);
        try {
          Sentry.captureException(err, {
            level: 'error',
            tags: { cron_job: 'subscription-check', step: 'expiry-notices' },
          });
        } catch { /* Sentry 미설정 무시 */ }
        expiryNotices = { sent: 0, skipped: 0, errors: [msg] };
      }

      // #49 DB 백업 heartbeat — 마지막 성공 백업이 30시간을 넘기면 운영자(MASTER)에게 하루 1통 (KST 날짜 기준).
      //   expiryNotices 와 같은 원칙: 이 단계는 throw 하지 않으며(실패는 결과에만 기록) 전이 결과 반환을 막지 않음.
      //   같은 날 재실행(수동 호출 등)은 AdminActivityLog(BACKUP_STALE_ALERT) 로 중복 발송 방지.
      let backupHeartbeat: BackupHeartbeatOutcome;
      try {
        backupHeartbeat = await this.checkBackupHeartbeat(new Date());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`DB 백업 heartbeat 점검 실패 (전이 결과는 정상 반환): ${msg}`);
        try {
          Sentry.captureException(err, {
            level: 'error',
            tags: { cron_job: 'subscription-check', step: 'backup-heartbeat' },
          });
        } catch { /* Sentry 미설정 무시 */ }
        backupHeartbeat = {
          status: 'error',
          lastSuccessfulBackupAt: null,
          lastBackupStatus: null,
          ageHours: null,
          thresholdHours: BACKUP_STALE_HOURS,
          alertSent: false,
          error: msg,
        };
      }
      this.logger.log(
        `Backup heartbeat: status=${backupHeartbeat.status}, lastSuccess=${backupHeartbeat.lastSuccessfulBackupAt ?? 'none'}, age=${backupHeartbeat.ageHours ?? '-'}h, alertSent=${backupHeartbeat.alertSent}${backupHeartbeat.skipped ? ` (${backupHeartbeat.skipped})` : ''}`,
      );

      this.logger.log(
        `Subscription cron: trial=${trialResult.processed}, activePastDue=${activePastDueResult.processed}, suspended=${pastDueResult.processed}, overdue=${overdueResult.markedOverdue}, expiryNotices=${expiryNotices.sent}/${expiryNotices.skipped}/${expiryNotices.errors.length}`,
      );
      return {
        timestamp: new Date().toISOString(),
        trialExpired: trialResult,
        activePastDue: activePastDueResult,
        pastDueSuspended: pastDueResult,
        invoicesOverdue: overdueResult,
        expiryNotices,
        backupHeartbeat,
      };
    }, { idempotent: true });
  }

  // ══════════════════════════════════════════════
  // #49 DB 백업 heartbeat
  // ══════════════════════════════════════════════

  @Post('backup-report')
  @ApiOperation({
    summary:
      'DB 백업 heartbeat 보고 (#49) — GitHub Actions db-backup.yml 이 성공/실패 시 호출, BackupJob 기록 (Bearer CRON_SECRET)',
  })
  async backupReport(
    @Body() body: BackupReportDto,
    @Headers('authorization') auth?: string,
  ) {
    this.assertCronAuth(auth);
    // 기록 1건 생성 — 재시도 시 중복 행 방지를 위해 idempotent:false (실패는 Sentry + CRON_FAILED 감사 기록 → 500)
    return this.runCronJob(
      'backup-report',
      async () => {
        const now = new Date();
        const ok = body.status === 'success';
        const startedAt = this.parseIsoDate(body.startedAt) ?? now;
        const completedAt = this.parseIsoDate(body.finishedAt) ?? now;
        const sizeBytes =
          typeof body.sizeBytes === 'number' && Number.isFinite(body.sizeBytes)
            ? body.sizeBytes
            : null;
        const message = body.message?.trim() || null;

        // 전체 DB 백업 — 센터 귀속 없음(siteId NULL). 센터 관리자 조회는 OR:[{siteId},{siteId:null}] (함정 #11)
        const job = await this.prisma.backupJob.create({
          data: {
            type: BACKUP_JOB_TYPE.SCHEDULED,
            status: ok ? BACKUP_JOB_STATUS.COMPLETED : BACKUP_JOB_STATUS.FAILED,
            startedAt,
            completedAt,
            metadata: JSON.stringify({
              source: 'github-actions',
              sizeBytes,
              message,
              reportedAt: now.toISOString(),
            }),
          },
          select: { id: true, status: true, startedAt: true, completedAt: true },
        });

        if (ok) {
          this.logger.log(
            `Backup report: 성공 기록 ${job.id} (size=${formatBytes(sizeBytes) ?? '-'}, finished=${completedAt.toISOString()})`,
          );
        } else {
          this.logger.error(`Backup report: 실패 기록 ${job.id} — ${message ?? '(메시지 없음)'}`);
          try {
            Sentry.captureMessage(`DB 백업 실패 보고: ${message ?? '(메시지 없음)'}`, {
              level: 'error',
              tags: { cron_job: 'backup-report' },
            });
          } catch { /* Sentry 미설정 무시 */ }
        }

        return {
          timestamp: now.toISOString(),
          recorded: true,
          job: {
            id: job.id,
            status: job.status,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            sizeBytes,
          },
        };
      },
      { idempotent: false },
    );
  }

  // ══════════════════════════════
  // 메일 설정 진단 / 실발송 테스트 (운영자 전용, Bearer CRON_SECRET)
  // ══════════════════════════════

  @Get('mail-status')
  @ApiOperation({
    summary:
      '메일 설정 진단 — RESEND_API_KEY / 발신주소 / 수신주소가 실제로 유효한지 확인 (Bearer CRON_SECRET)',
  })
  async mailStatus(@Headers('authorization') auth?: string) {
    this.assertCronAuth(auth);
    const raw = process.env.RESEND_FROM_EMAIL ?? '';
    // 환경변수에 섞인 공백/줄바꿈은 화면에 안 보이면서 발송을 깨뜨린다 — 명시적으로 알린다.
    const fromHasWhitespace = raw !== raw.trim() || raw.includes(' ');
    const configured = this.notifications.isConfigured();
    return {
      timestamp: new Date().toISOString(),
      resendConfigured: configured,
      fromEmail: raw.trim() || '(기본값) noreply@sae-work.com',
      fromEmailHasWhitespace: fromHasWhitespace,
      masterEmail: this.notifications.masterEmail(),
      heatAlertEmailSet: Boolean(process.env.HEAT_ALERT_EMAIL),
      ready: configured,
    };
  }

  @Post('mail-test')
  @ApiOperation({
    summary:
      '메일 실발송 테스트 — 운영자 주소로 1통 발송 후 결과를 그대로 반환 (Bearer CRON_SECRET)',
  })
  async mailTest(@Headers('authorization') auth?: string) {
    this.assertCronAuth(auth);
    const now = new Date();
    const to = this.notifications.masterEmail();
    const result = await this.notifications.sendMail({
      to,
      subject: `[새롬GLS] 메일 발송 테스트 ${now.toISOString()}`,
      html:
        '<p>메일 발송 경로가 정상 동작합니다.</p>' +
        `<p>발송 시각: ${now.toISOString()}</p>`,
    });
    // 실패를 성공으로 표시하지 않는다 — 실패 사유를 그대로 노출한다.
    return { timestamp: now.toISOString(), to, ...result };
  }

  /**
   * #49 마지막 성공 백업이 BACKUP_STALE_HOURS(30h) 초과(또는 성공 기록 없음)면 MASTER 에게 경고 메일 1통.
   * - 하루 1회: 오늘(KST) BACKUP_STALE_ALERT 감사 기록이 있으면 생략
   * - sendMail 은 throw 하지 않음. 이 메서드는 Prisma 조회 실패 시에만 throw (호출 측 try/catch)
   */
  private async checkBackupHeartbeat(now: Date): Promise<BackupHeartbeatOutcome> {
    const hb = await loadBackupHeartbeat(this.prisma, {}, now);
    const base = {
      lastSuccessfulBackupAt: hb.lastSuccessfulBackupAt?.toISOString() ?? null,
      lastBackupStatus: hb.lastBackupStatus,
      ageHours: hb.ageHours,
      thresholdHours: hb.thresholdHours,
    };
    if (!hb.stale) {
      return { status: 'ok', ...base, alertSent: false };
    }

    // 하루 1회 — 오늘(KST) 이미 발송했으면 생략
    const alreadySent = await this.prisma.adminActivityLog.findFirst({
      where: {
        actionType: BACKUP_STALE_ALERT_ACTION,
        createdAt: { gte: this.kstDayStart(now) },
      },
      select: { id: true },
    });
    if (alreadySent) {
      this.logger.log('Backup heartbeat: 백업 지연 상태이나 오늘 이미 경고 발송 → 생략');
      return { status: 'stale', ...base, alertSent: false, skipped: 'already-sent-today' };
    }

    const todayKey = this.kstDateKey(now);
    const subject =
      hb.lastSuccessfulBackupAt === null
        ? `[새롬GLS] DB 백업 경고 ${todayKey} — 성공 백업 기록 없음`
        : `[새롬GLS] DB 백업 경고 ${todayKey} — 마지막 성공 백업 ${this.formatElapsed(hb.lastSuccessfulBackupAt, now)} 경과`;
    const sendResult = await this.notifications.sendMail({
      to: this.notifications.masterEmail(),
      subject,
      html: this.renderBackupStaleHtml(hb, now),
    });

    if (!sendResult.ok) {
      if (sendResult.error === 'no-api-key') {
        this.logger.warn('Backup heartbeat: RESEND_API_KEY 미설정 → 경고 미발송');
        return { status: 'stale', ...base, alertSent: false, skipped: 'no-api-key' };
      }
      this.logger.error(`Backup heartbeat: 경고 발송 실패 — ${sendResult.error}`);
      try {
        Sentry.captureMessage(`backup-heartbeat 경고 발송 실패: ${sendResult.error}`, {
          level: 'error',
          tags: { cron_job: 'subscription-check', step: 'backup-heartbeat' },
        });
      } catch { /* Sentry 미설정 무시 */ }
      return { status: 'stale', ...base, alertSent: false, error: sendResult.error };
    }

    this.logger.warn(`Backup heartbeat: 경고 발송 "${subject}"`);
    // 발송 기록 (하루 1회 판정 근거) — 기록 실패는 흐름을 막지 않음 (다음 실행은 크론 주기상 다음 날)
    try {
      const actor = await resolveSystemActorId(this.prisma);
      if (!actor) {
        this.logger.warn('Backup heartbeat: 시스템 행위자(MASTER) 없음 → 발송 기록 생략 (중복 방지 불가)');
      } else {
        await this.prisma.adminActivityLog.create({
          data: {
            actorWorkerId: actor,
            actionType: BACKUP_STALE_ALERT_ACTION,
            targetType: 'CRON',
            targetId: 'backup-heartbeat',
            metadata: systemMetadata({
              ...base,
              mailId: sendResult.id ?? null,
              sentAt: now.toISOString(),
            }),
          },
        });
      }
    } catch (err) {
      this.logger.warn(`Backup heartbeat: 발송 기록 실패 (중복 방지 불가): ${err}`);
    }
    return { status: 'stale', ...base, alertSent: true, mailId: sendResult.id };
  }

  /** #49 백업 지연 경고 메일 본문 */
  private renderBackupStaleHtml(hb: BackupHeartbeat, now: Date): string {
    const esc = (v: unknown) => this.escapeHtml(v);
    const base = webBaseUrl();
    const lastSuccessText = hb.lastSuccessfulBackupAt
      ? `${this.kstDateTime(hb.lastSuccessfulBackupAt)} (KST) — ${this.formatElapsed(hb.lastSuccessfulBackupAt, now)} 경과`
      : '기록 없음';
    const lastFailureText = hb.lastFailure
      ? `${this.kstDateTime(hb.lastFailure.at)} (KST)${hb.lastFailure.message ? ` — ${esc(hb.lastFailure.message)}` : ''}`
      : '없음';
    const row = (label: string, value: string) =>
      `<tr><th style="${TH_STYLE}white-space:nowrap;">${esc(label)}</th><td style="${TD_STYLE}">${value}</td></tr>`;

    return `
<div style="font-family:'Malgun Gothic','Apple SD Gothic Neo',Arial,sans-serif;font-size:14px;color:#222;line-height:1.5;">
  <h2 style="margin:0 0 8px;font-size:18px;color:#b91c1c;">DB 백업 경고 — ${hb.lastSuccessfulBackupAt ? `마지막 성공 백업 ${esc(this.formatElapsed(hb.lastSuccessfulBackupAt, now))} 경과` : '성공 백업 기록 없음'}</h2>
  <p style="margin:0 0 12px;color:#555;">
    기준 시각 ${this.kstDateTime(now)} (KST) · 기준: 마지막 성공 백업 ${BACKUP_STALE_HOURS}시간 초과 시 경고 (하루 1회).
  </p>
  <table style="border-collapse:collapse;width:100%;max-width:720px;">
    ${row('마지막 성공 백업', esc(lastSuccessText))}
    ${row('최근 백업 상태', esc(hb.lastBackupStatus ?? '기록 없음'))}
    ${row('최근 백업 시각', hb.lastBackupAt ? `${this.kstDateTime(hb.lastBackupAt)} (KST)` : '기록 없음')}
    ${row('최근 실패', lastFailureText)}
  </table>
  <h3 style="margin:16px 0 6px;font-size:15px;">확인할 것</h3>
  <ol style="margin:0;padding-left:18px;color:#333;">
    <li>GitHub 저장소(backend) › Actions › <strong>Daily DB Backup</strong> 워크플로 최근 실행이 성공했는지</li>
    <li>워크플로 Secrets: <code>DATABASE_URL_DIRECT</code> (Neon unpooled), <code>API_BASE_URL</code>, <code>CRON_SECRET</code> (Vercel 값과 동일)</li>
    <li>워크플로가 성공했는데 이 메일이 왔다면 heartbeat(<code>POST /api/cron/backup-report</code>) 보고 스텝 로그 확인</li>
  </ol>
  <p style="margin:12px 0 0;"><a href="${base}/data-protection" style="color:#2563eb;">웹 대시보드 › 데이터 보호</a>에서 백업 이력을 볼 수 있습니다.</p>
  <p style="margin-top:16px;font-size:12px;color:#888;">이 메일은 새롬GLS 작업현황 공유 시스템이 운영자(MASTER)에게 자동 발송했습니다.</p>
</div>`;
  }

  /** ISO 문자열 → Date (파싱 실패/빈값은 null) */
  private parseIsoDate(value?: string): Date | null {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** KST 자정(해당 날짜 00:00 KST)의 Date — 서버 타임존 무관 */
  private kstDayStart(date: Date): Date {
    return new Date(Date.parse(`${this.kstDateKey(date)}T00:00:00+09:00`));
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
          const actor = await resolveSystemActorId(this.prisma);
          if (!actor) {
            this.logger.warn('[purge] 시스템 행위자(MASTER) 없음 → DATA_RETENTION_PURGE 감사 기록 생략');
            return;
          }
          await this.prisma.adminActivityLog.create({
            data: {
              actorWorkerId: actor,
              actionType: 'DATA_RETENTION_PURGE',
              targetType: 'CRON',
              targetId: 'monthly-purge',
              metadata: systemMetadata(purgeStats),
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

  // ══════════════════════════════════════════════
  // 알림 크론 (#13 종료 누락 · #17 구독 · #25 허브 · #31 다이제스트 · #32 요약 · [F] 폭염 예보)
  // ══════════════════════════════════════════════

  @Get('heat-forecast-notice')
  @ApiOperation({
    summary: '매일 06:00 KST — 오늘 근무시간대 최고 WBGT 예보가 주의 이상인 센터에 사전 알림 (계약 [F])',
  })
  async heatForecastNotice(@Headers('authorization') auth?: string) {
    this.assertCronAuth(auth);
    // 발송이 센터별로 즉시 일어남 → 재시도 시 중복 발송 방지를 위해 idempotent:false
    return this.runCronJob(
      'heat-forecast-notice',
      async () => {
        const result = await this.heatAlertsService.runHeatForecastNotices();
        this.logger.log(
          `Heat forecast notice cron: sent=${result.sent}, skipped=${result.skipped}, errors=${result.errors.length}`,
        );
        if (result.errors.length > 0) {
          this.logger.error(`Heat forecast notice errors: ${JSON.stringify(result.errors)}`);
        }
        return { timestamp: new Date().toISOString(), ...result };
      },
      { idempotent: false },
    );
  }

  @Get('evening-notices')
  @ApiOperation({
    summary:
      '매일 20:00 KST — 종료 누락 작업 알림(#13) + 일일 작업 요약(#32, summaryDaily 센터만) + MASTER 롤업 1통',
  })
  async eveningNotices(@Headers('authorization') auth?: string) {
    this.assertCronAuth(auth);
    return this.runCronJob(
      'evening-notices',
      () => this.runNoticeCycle({ jobName: 'evening-notices', summaryType: 'daily', includeStuck: true }),
      { idempotent: false },
    );
  }

  @Get('weekly-summary')
  @ApiOperation({
    summary: '매주 월 00:00 KST — 지난 7일 주간 작업 요약(#32, summaryWeekly 센터만) + MASTER 롤업 1통',
  })
  async weeklySummary(@Headers('authorization') auth?: string) {
    this.assertCronAuth(auth);
    return this.runCronJob(
      'weekly-summary',
      () => this.runNoticeCycle({ jobName: 'weekly-summary', summaryType: 'weekly', includeStuck: false }),
      { idempotent: false },
    );
  }

  @Get('ops-digest')
  @ApiOperation({
    summary: '매일 09:30 KST — MASTER 아침 운영 다이제스트(#31). 이상 센터가 있을 때만 운영자 메일 발송',
  })
  async opsDigest(@Headers('authorization') auth?: string) {
    this.assertCronAuth(auth);
    // buildOpsDigest 는 읽기 전용이고 sendMail 은 throw 하지 않으며 마지막에 1회만 호출되므로
    // 재시도(idempotent:true)는 다이제스트 생성 단계 실패에만 걸리고 중복 발송은 없음.
    return this.runCronJob(
      'ops-digest',
      async () => {
        const timestamp = new Date().toISOString();
        const digest = await this.customerOpsService.buildOpsDigest();
        if (!digest.hasIssues) {
          this.logger.log('Ops digest cron: 이상 없음 → 발송 생략');
          return { timestamp, hasIssues: false, sent: false, skipped: true };
        }
        const sendResult = await this.notifications.sendMail({
          to: this.notifications.masterEmail(),
          subject: digest.subject,
          html: digest.html,
        });
        if (sendResult.ok) {
          this.logger.log(`Ops digest cron: 발송 완료 "${digest.subject}"`);
        } else if (sendResult.error === 'no-api-key') {
          this.logger.warn('Ops digest cron: RESEND_API_KEY 미설정 → 미발송');
        } else {
          this.logger.error(`Ops digest cron: 발송 실패 — ${sendResult.error}`);
          try {
            Sentry.captureMessage(`ops-digest 발송 실패: ${sendResult.error}`, {
              level: 'error',
              tags: { cron_job: 'ops-digest' },
            });
          } catch { /* Sentry 미설정 무시 */ }
        }
        return {
          timestamp,
          hasIssues: true,
          sent: sendResult.ok,
          skipped: sendResult.error === 'no-api-key',
          mailId: sendResult.id,
          error: sendResult.ok ? undefined : sendResult.error,
        };
      },
      { idempotent: true },
    );
  }

  // ──────────────────────────────────────────────
  // 저녁/주간 알림 공통 사이클
  // ──────────────────────────────────────────────

  /**
   * 저녁(종료 누락 + 일일 요약) / 주간(주간 요약) 알림 공통 사이클.
   * - 최상위 활성 센터(parentSiteId null, isActive) 순회, 센터별 try/catch
   *   (종료 누락 단계와 요약 단계도 서로 독립 — 한 단계 실패가 다른 단계를 막지 않음)
   * - 구독 EXPIRED/SUSPENDED/CANCELLED 센터는 고객 발송 제외 (롤업엔 상태 표기)
   * - siteId NULL 작업자의 작업은 첫 센터(가장 오래된 최상위 활성 센터)에만 귀속
   * - 요약은 TenantSettings.notifications.summaryDaily / summaryWeekly === true 센터만
   * - 마지막에 MASTER 롤업 1통 (센터별 한 줄). 발송이 센터별로 즉시 일어나므로
   *   호출 측 runCronJob 은 반드시 idempotent:false
   * - 이 메서드는 throw 하지 않음 (센터 목록 조회 실패만 예외 → runCronJob 이 Sentry/감사 기록)
   */
  private async runNoticeCycle(opts: {
    jobName: string;
    summaryType: 'daily' | 'weekly';
    includeStuck: boolean;
  }) {
    const now = new Date();
    const todayKey = this.kstDateKey(now);
    const summaryLabel = opts.summaryType === 'daily' ? '일일 요약' : '주간 요약';
    const summaryFlag = opts.summaryType === 'daily' ? 'summaryDaily' : 'summaryWeekly';
    const stuckCounter: SendCounter = { sent: 0, skipped: 0 };
    const summaryCounter: SendCounter = { sent: 0, skipped: 0 };
    const errors: string[] = [];
    const rollupRows: string[][] = [];

    const sites = await this.listTopLevelActiveSites();
    const firstSiteId = sites[0]?.id ?? null;

    for (const site of sites) {
      let subscriptionStatus = 'NONE';
      let stuckOutcome = '-';
      let summaryOutcome = '-';
      try {
        subscriptionStatus = await this.latestSubscriptionStatus(site.id);

        if (!this.isCustomerNotifiable(subscriptionStatus)) {
          if (opts.includeStuck) {
            stuckCounter.skipped++;
            stuckOutcome = '구독 종료 — 발송 제외';
          }
          summaryCounter.skipped++;
          summaryOutcome = '구독 종료 — 발송 제외';
          this.logger.log(
            `[${opts.jobName}] 구독 ${subscriptionStatus} → 고객 발송 제외 (site ${site.id} ${site.name})`,
          );
        } else {
          // (1) #13 종료 누락 작업 알림
          if (opts.includeStuck) {
            try {
              stuckOutcome = await this.notifyStuckWorkForSite(
                site,
                site.id === firstSiteId,
                now,
                stuckCounter,
                errors,
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(`${site.name}: 종료 누락 알림 처리 실패 — ${msg}`);
              stuckOutcome = '처리 실패';
              this.logger.error(
                `[${opts.jobName}] 종료 누락 알림 실패 (site ${site.id} ${site.name}): ${msg}`,
              );
            }
          }

          // (2) #32 일일/주간 요약 — 신청 센터만
          try {
            const notif = await this.getNotificationSettings(site.id);
            if (notif[summaryFlag] !== true) {
              summaryCounter.skipped++;
              summaryOutcome = '미신청';
            } else {
              summaryOutcome = await this.sendSummaryForSite(
                site,
                opts.summaryType,
                summaryCounter,
                errors,
              );
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${site.name}: ${summaryLabel} 처리 실패 — ${msg}`);
            summaryOutcome = '처리 실패';
            this.logger.error(
              `[${opts.jobName}] ${summaryLabel} 실패 (site ${site.id} ${site.name}): ${msg}`,
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${site.name}: ${msg}`);
        if (opts.includeStuck && stuckOutcome === '-') stuckOutcome = '처리 실패';
        if (summaryOutcome === '-') summaryOutcome = '처리 실패';
        this.logger.error(`[${opts.jobName}] 센터 처리 실패 (site ${site.id} ${site.name}): ${msg}`);
      }

      rollupRows.push(
        opts.includeStuck
          ? [site.name, site.code, subscriptionStatus, stuckOutcome, summaryOutcome]
          : [site.name, site.code, subscriptionStatus, summaryOutcome],
      );
    }

    // (3) MASTER 롤업 1통 — 센터별 한 줄, 마지막에 발송
    let master: MasterOutcome = 'skipped';
    if (rollupRows.length > 0) {
      const subject = opts.includeStuck
        ? `[새롬GLS] 저녁 알림 롤업 ${todayKey} — 종료누락 ${stuckCounter.sent}건 · 일일요약 ${summaryCounter.sent}건 발송`
        : `[새롬GLS] 주간 요약 롤업 ${todayKey} — ${summaryCounter.sent}건 발송`;
      const footerParts = [] as string[];
      if (opts.includeStuck) {
        footerParts.push(`종료 누락: 발송 ${stuckCounter.sent} / 생략 ${stuckCounter.skipped}`);
      }
      footerParts.push(`${summaryLabel}: 발송 ${summaryCounter.sent} / 생략 ${summaryCounter.skipped}`);
      footerParts.push(`오류 ${errors.length}건`);

      master = await this.sendMasterRollup({
        subject,
        title: opts.includeStuck ? `저녁 알림 롤업 (${todayKey})` : `주간 요약 롤업 (${todayKey})`,
        description: opts.includeStuck
          ? '센터별 종료 누락 작업 알림과 일일 요약 발송 결과입니다. 구독 종료 센터는 고객 발송에서 제외됩니다.'
          : '센터별 주간 요약 발송 결과입니다. 구독 종료 센터는 고객 발송에서 제외됩니다.',
        columns: opts.includeStuck
          ? ['센터', '코드', '구독', '종료 누락', '일일 요약']
          : ['센터', '코드', '구독', '주간 요약'],
        rows: rollupRows,
        footer: footerParts.join(' · '),
        errors: [...errors],
        generatedAt: now,
      }, errors);
    }

    const summaryLine =
      `Cron ${opts.jobName}: sites=${sites.length}` +
      (opts.includeStuck ? `, stuck=${stuckCounter.sent}/${stuckCounter.skipped}` : '') +
      `, summary=${summaryCounter.sent}/${summaryCounter.skipped}, master=${master}, errors=${errors.length}`;
    if (errors.length > 0) {
      this.logger.error(`${summaryLine} — ${JSON.stringify(errors)}`);
    } else {
      this.logger.log(summaryLine);
    }

    return {
      timestamp: now.toISOString(),
      sites: sites.length,
      ...(opts.includeStuck ? { stuck: stuckCounter } : {}),
      summary: summaryCounter,
      master,
      errors,
    };
  }

  /**
   * #13 센터 1곳의 종료 누락 작업 메일.
   * 대상: 진행 중(ACTIVE) 전체 + 일시정지(PAUSED) 중 시작 후 24시간 초과.
   * WorkItem 엔 siteId 가 없어 startedByWorker.siteId 로 조인 (NULL 작업자는 첫 센터에만 귀속).
   * 0건이면 미발송, 수신자(stuck_work) 없으면 skip (MASTER 폴백 없음).
   * 반환: 롤업 표에 넣을 한 줄 결과 문구.
   */
  private async notifyStuckWorkForSite(
    site: CronSite,
    includeNullSite: boolean,
    now: Date,
    counter: SendCounter,
    errors: string[],
  ): Promise<string> {
    const pausedThreshold = new Date(now.getTime() - STUCK_PAUSED_HOURS * 60 * 60 * 1000);
    const items = await this.prisma.workItem.findMany({
      where: {
        ...this.workScopeFor(site.id, includeNullSite),
        OR: [{ status: 'ACTIVE' }, { status: 'PAUSED', startedAt: { lte: pausedThreshold } }],
      },
      select: {
        id: true,
        status: true,
        startedAt: true,
        startedByWorker: { select: { name: true, employeeCode: true } },
        classification: { select: { displayName: true, code: true } },
      },
      orderBy: { startedAt: 'asc' },
    });

    if (items.length === 0) {
      counter.skipped++;
      return '0건';
    }

    const recipients = await this.notifications.resolveRecipients(site.id, 'stuck_work');
    if (recipients.length === 0) {
      counter.skipped++;
      this.logger.warn(
        `종료 누락 알림 스킵(수신자 없음): ${site.name} ${items.length}건`,
      );
      return `${items.length}건 (수신자 없음)`;
    }

    const subject = `[새롬GLS][${site.name}] 종료되지 않은 작업 ${items.length}건`;
    const html = this.renderStuckWorkHtml(site, items, now);
    const sendResult = await this.notifications.sendMail({ to: recipients, subject, html });
    const outcome = this.applySendResult(sendResult, counter, errors, `${site.name} 종료 누락 알림`);
    if (sendResult.ok) {
      this.logger.log(`종료 누락 알림 발송: ${site.name} ${items.length}건 → ${recipients.length}명`);
    }
    return `${items.length}건 ${outcome}`;
  }

  /**
   * #32 센터 1곳의 일일/주간 요약 메일 발송.
   * buildSummaryMail 이 null(활동 없음/권한 없음/비활성)이면 생략, 수신자(summary) 없으면 skip.
   * 반환: 롤업 표에 넣을 한 줄 결과 문구.
   */
  private async sendSummaryForSite(
    site: CronSite,
    type: 'daily' | 'weekly',
    counter: SendCounter,
    errors: string[],
  ): Promise<string> {
    const label = type === 'daily' ? '일일 요약' : '주간 요약';
    const mail = await this.reportsService.buildSummaryMail(site.id, type);
    if (!mail) {
      counter.skipped++;
      return '생략(활동 없음/권한 없음)';
    }
    const recipients = await this.notifications.resolveRecipients(site.id, 'summary');
    if (recipients.length === 0) {
      counter.skipped++;
      this.logger.warn(`${label} 스킵(수신자 없음): ${site.name}`);
      return '수신자 없음';
    }
    const sendResult = await this.notifications.sendMail({
      to: recipients,
      subject: mail.subject,
      html: mail.html,
    });
    const outcome = this.applySendResult(sendResult, counter, errors, `${site.name} ${label}`);
    if (sendResult.ok) {
      this.logger.log(`${label} 발송: ${site.name} → ${recipients.length}명`);
    }
    return outcome;
  }

  /** MASTER 롤업 메일 1통 (masterEmail). 실패는 errors[] 에 누적, throw 하지 않음 */
  private async sendMasterRollup(
    input: {
      subject: string;
      title: string;
      description: string;
      columns: string[];
      rows: string[][];
      footer: string;
      errors: string[];
      generatedAt: Date;
    },
    errors: string[],
  ): Promise<MasterOutcome> {
    try {
      const html = this.renderRollupHtml(input);
      const sendResult = await this.notifications.sendMail({
        to: this.notifications.masterEmail(),
        subject: input.subject,
        html,
      });
      if (sendResult.ok) {
        this.logger.log(`MASTER 롤업 발송: "${input.subject}"`);
        return 'sent';
      }
      if (sendResult.error === 'no-api-key') return 'skipped';
      errors.push(`MASTER 롤업 발송 실패 (${sendResult.error || 'unknown'})`);
      return 'failed';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`MASTER 롤업: ${msg}`);
      this.logger.error(`MASTER 롤업 처리 실패: ${msg}`);
      return 'failed';
    }
  }

  /** sendMail 결과 → 카운터 반영 + 롤업 문구. 실패는 errors[] 누적 (throw 없음) */
  private applySendResult(
    result: { ok: boolean; error?: string },
    counter: SendCounter,
    errors: string[],
    label: string,
  ): SendOutcome {
    if (result.ok) {
      counter.sent++;
      return '발송';
    }
    if (result.error === 'no-api-key') {
      counter.skipped++;
      return '미발송(메일 미설정)';
    }
    errors.push(`${label}: 메일 발송 실패 (${result.error || 'unknown'})`);
    return '발송 실패';
  }

  // ──────────────────────────────────────────────
  // 조회 헬퍼 (멀티테넌트)
  // ──────────────────────────────────────────────

  /** 최상위 활성 센터 (parentSiteId null, isActive) — 생성 순 (첫 항목 = NULL 데이터 귀속 센터) */
  private async listTopLevelActiveSites(): Promise<CronSite[]> {
    return this.prisma.site.findMany({
      where: { parentSiteId: null, isActive: true },
      select: { id: true, name: true, code: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** 센터의 최신 구독 상태 (없으면 'NONE'). 대소문자 혼용 대비 toUpperCase (함정 #21) */
  private async latestSubscriptionStatus(siteId: string): Promise<string> {
    const sub = await this.prisma.subscription.findFirst({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
      select: { status: true },
    });
    return String(sub?.status || 'NONE').toUpperCase();
  }

  /** 구독 EXPIRED/SUSPENDED/CANCELLED 는 고객 발송 제외. 구독 기록 없음(NONE)은 발송 대상 */
  private isCustomerNotifiable(subscriptionStatus: string): boolean {
    return !CUSTOMER_EXCLUDED_SUBSCRIPTION_STATUSES.includes(subscriptionStatus);
  }

  /** TenantSettings.settings JSON 의 notifications 객체 (없음/파싱 실패 시 {}) */
  private async getNotificationSettings(siteId: string): Promise<Record<string, unknown>> {
    const ts = await this.prisma.tenantSettings.findUnique({
      where: { siteId },
      select: { settings: true },
    });
    if (!ts?.settings) return {};
    try {
      const parsed = JSON.parse(ts.settings) as { notifications?: unknown };
      const notif = parsed?.notifications;
      return notif && typeof notif === 'object' && !Array.isArray(notif)
        ? (notif as Record<string, unknown>)
        : {};
    } catch (err) {
      this.logger.warn(`TenantSettings JSON 파싱 실패 (site ${siteId}): ${err}`);
      return {};
    }
  }

  /**
   * WorkItem 은 siteId 컬럼이 없음 → startedByWorker.siteId 로 조인.
   * siteId NULL 작업자(레거시)는 첫 센터에만 귀속 (OR:[{siteId},{siteId:null}] 패턴, 함정 #11)
   */
  private workScopeFor(siteId: string, includeNullSite: boolean): Prisma.WorkItemWhereInput {
    return {
      startedByWorker: includeNullSite ? { OR: [{ siteId }, { siteId: null }] } : { siteId },
    };
  }

  // ──────────────────────────────────────────────
  // 메일 HTML (간단한 인라인 스타일 표)
  // ──────────────────────────────────────────────

  private renderStuckWorkHtml(
    site: CronSite,
    items: Array<{
      id: string;
      status: string;
      startedAt: Date;
      startedByWorker: { name: string; employeeCode: string };
      classification: { displayName: string; code: string };
    }>,
    now: Date,
  ): string {
    const esc = (v: unknown) => this.escapeHtml(v);
    const base = webBaseUrl();
    const shown = items.slice(0, STUCK_MAIL_MAX_ROWS);
    const rest = items.length - shown.length;
    const statusLabel = (s: string) =>
      s.toUpperCase() === 'PAUSED' ? '일시정지' : s.toUpperCase() === 'ACTIVE' ? '진행 중' : s;

    const rows = shown
      .map(
        (item, idx) => `
        <tr>
          <td style="${TD_STYLE}">${idx + 1}</td>
          <td style="${TD_STYLE}">${esc(item.startedByWorker?.name ?? '-')} <span style="color:#888;">(${esc(item.startedByWorker?.employeeCode ?? '-')})</span></td>
          <td style="${TD_STYLE}">${esc(item.classification?.displayName ?? item.classification?.code ?? '-')}</td>
          <td style="${TD_STYLE}">${esc(statusLabel(item.status))}</td>
          <td style="${TD_STYLE}">${this.kstDateTime(item.startedAt)}</td>
          <td style="${TD_STYLE}">${this.formatElapsed(item.startedAt, now)}</td>
          <td style="${TD_STYLE}"><a href="${base}/work-items/${encodeURIComponent(item.id)}" style="color:#2563eb;">상세 보기</a></td>
        </tr>`,
      )
      .join('');

    return `
<div style="font-family:'Malgun Gothic','Apple SD Gothic Neo',Arial,sans-serif;font-size:14px;color:#222;line-height:1.5;">
  <h2 style="margin:0 0 8px;font-size:18px;">[${esc(site.name)}] 종료되지 않은 작업 ${items.length}건</h2>
  <p style="margin:0 0 12px;color:#555;">
    기준 시각 ${this.kstDateTime(now)} (KST) · 대상: 진행 중(ACTIVE) 전체 + 일시정지(PAUSED) 시작 후 ${STUCK_PAUSED_HOURS}시간 초과.<br/>
    실제로 끝난 작업이라면 웹 대시보드에서 종료 처리해 주세요. 종료 누락은 작업시간·성과 집계에 영향을 줍니다.
  </p>
  <table style="border-collapse:collapse;width:100%;max-width:820px;">
    <thead>
      <tr>
        <th style="${TH_STYLE}">#</th>
        <th style="${TH_STYLE}">작업자</th>
        <th style="${TH_STYLE}">분류</th>
        <th style="${TH_STYLE}">상태</th>
        <th style="${TH_STYLE}">시작 시각</th>
        <th style="${TH_STYLE}">경과</th>
        <th style="${TH_STYLE}">상세</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>
  ${rest > 0 ? `<p style="margin:8px 0 0;color:#555;">외 ${rest}건 — <a href="${base}/work-items" style="color:#2563eb;">작업 기록</a>에서 확인해 주세요.</p>` : ''}
  <p style="margin-top:16px;font-size:12px;color:#888;">
    이 메일은 새롬GLS 작업현황 공유 시스템이 자동 발송했습니다. 수신자 변경: 웹 대시보드 › 사업장 설정 › 알림 (stuck_work)
  </p>
</div>`;
  }

  private renderRollupHtml(input: {
    title: string;
    description: string;
    columns: string[];
    rows: string[][];
    footer: string;
    errors: string[];
    generatedAt: Date;
  }): string {
    const esc = (v: unknown) => this.escapeHtml(v);
    const head = input.columns.map((c) => `<th style="${TH_STYLE}">${esc(c)}</th>`).join('');
    const body = input.rows
      .map(
        (row) =>
          `<tr>${row.map((cell) => `<td style="${TD_STYLE}">${esc(cell)}</td>`).join('')}</tr>`,
      )
      .join('');
    const errorBlock =
      input.errors.length > 0
        ? `
  <h3 style="margin:16px 0 6px;font-size:15px;color:#b91c1c;">오류 ${input.errors.length}건</h3>
  <ul style="margin:0;padding-left:18px;color:#b91c1c;">
    ${input.errors.map((e) => `<li>${esc(e)}</li>`).join('')}
  </ul>`
        : '';

    return `
<div style="font-family:'Malgun Gothic','Apple SD Gothic Neo',Arial,sans-serif;font-size:14px;color:#222;line-height:1.5;">
  <h2 style="margin:0 0 8px;font-size:18px;">${esc(input.title)}</h2>
  <p style="margin:0 0 12px;color:#555;">${esc(input.description)}<br/>생성 시각 ${this.kstDateTime(input.generatedAt)} (KST)</p>
  <table style="border-collapse:collapse;width:100%;max-width:820px;">
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>
  <p style="margin:10px 0 0;color:#333;"><strong>${esc(input.footer)}</strong></p>
  ${errorBlock}
  <p style="margin-top:16px;font-size:12px;color:#888;">이 메일은 새롬GLS 작업현황 공유 시스템이 운영자(MASTER)에게 자동 발송했습니다.</p>
</div>`;
  }

  // ──────────────────────────────────────────────
  // 포맷 유틸
  // ──────────────────────────────────────────────

  /** KST 'YYYY-MM-DD' */
  private kstDateKey(date: Date): string {
    return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  /** KST 'YYYY-MM-DD HH:mm' */
  private kstDateTime(date: Date): string {
    const iso = new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }

  /** 경과 시간 문구 ('2일 3시간' / '5시간 12분' / '40분') */
  private formatElapsed(from: Date, to: Date): string {
    const mins = Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60000));
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const rem = mins % 60;
    if (days > 0) return `${days}일 ${hours}시간`;
    if (hours > 0) return `${hours}시간 ${rem}분`;
    return `${rem}분`;
  }

  private escapeHtml(value: unknown): string {
    const map: Record<string, string> = {
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      '"': '&quot;',
    };
    return String(value ?? '').replace(/[<>&"]/g, (c) => map[c] ?? c);
  }
}
