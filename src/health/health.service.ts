import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BACKUP_STALE_HOURS, loadBackupHeartbeat } from '../common/utils/backup-heartbeat';

/** readiness.checks.backups — 최신 BackupJob 기준 (#49 heartbeat). 필드명은 data-protection 과 동일 */
type BackupCheck = {
  /** ok: 30h 이내 성공 / stale: 성공 없음 또는 30h 초과 / unknown: 조회 실패 */
  status: 'ok' | 'stale' | 'unknown';
  lastSuccessfulBackupAt: Date | null;
  lastBackupStatus: string | null;
  lastBackupAt: Date | null;
  ageHours: number | null;
  thresholdHours: number;
  pendingRestoreRequests: number | null;
  error: string | null;
};

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  async getLiveness() {
    return {
      status: 'ok',
      service: 'saeromgls-api',
      now: new Date().toISOString(),
    };
  }

  async getReadiness() {
    let dbOk = false;
    let dbError: string | null = null;

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch (error) {
      dbError = error instanceof Error ? error.message : 'database unavailable';
    }

    // 백업 heartbeat (#49) — DB 장애 시에도 readiness 응답 자체는 유지 (500 대신 unknown)
    // 백업 지연은 서비스 가용성이 아니므로 최상위 status 는 DB 만 반영, backups.status 로 별도 노출
    let backups: BackupCheck;
    try {
      const [heartbeat, pendingRestoreRequests] = await Promise.all([
        loadBackupHeartbeat(this.prisma),
        this.prisma.restoreRequest.count({
          where: { status: { in: ['requested', 'reviewing'] } },
        }),
      ]);
      backups = {
        status: heartbeat.stale ? 'stale' : 'ok',
        lastSuccessfulBackupAt: heartbeat.lastSuccessfulBackupAt,
        lastBackupStatus: heartbeat.lastBackupStatus,
        lastBackupAt: heartbeat.lastBackupAt,
        ageHours: heartbeat.ageHours,
        thresholdHours: heartbeat.thresholdHours,
        pendingRestoreRequests,
        error: null,
      };
    } catch (error) {
      backups = {
        status: 'unknown',
        lastSuccessfulBackupAt: null,
        lastBackupStatus: null,
        lastBackupAt: null,
        ageHours: null,
        thresholdHours: BACKUP_STALE_HOURS,
        pendingRestoreRequests: null,
        error: error instanceof Error ? error.message : 'backup status unavailable',
      };
    }

    return {
      status: dbOk ? 'ok' : 'degraded',
      checks: {
        database: {
          status: dbOk ? 'ok' : 'error',
          error: dbError,
        },
        backups,
        observability: {
          sentryConfigured: Boolean(process.env.SENTRY_DSN),
        },
      },
      now: new Date().toISOString(),
    };
  }
}
