import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * #49 DB 백업 heartbeat 공통 계산
 *
 * - GitHub Actions `db-backup.yml` 이 성공/실패 시 POST /api/cron/backup-report 로 보고 → BackupJob 행 생성
 * - cron(subscription-check)·health(readiness)·data-protection(백업 상태) 이 "최신 BackupJob 기준"
 *   lastSuccessfulBackupAt / lastBackupStatus 를 동일한 계산으로 반환하도록 여기 한 곳에 둠
 * - 모듈 DI 없이 PrismaService 만 받는 순수 함수 (CronModule/HealthModule imports 변경 불필요)
 */

/** 마지막 성공 백업이 이 시간(시간 단위)을 넘기면 "지연(stale)" — 일간 백업 24h + 여유 6h */
export const BACKUP_STALE_HOURS = 30;

/** BackupJob.status 값 (DB 문자열 — 웹은 pending/running 을 in_progress 로 표시) */
export const BACKUP_JOB_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

/** BackupJob.type 값 — scheduled: GitHub Actions 일간 백업(heartbeat 보고), manual: 웹 수동 요청 */
export const BACKUP_JOB_TYPE = {
  MANUAL: 'manual',
  SCHEDULED: 'scheduled',
} as const;

export interface BackupHeartbeat {
  /** 마지막 성공(completed) 백업 완료 시각 — 성공 기록 없으면 null */
  lastSuccessfulBackupAt: Date | null;
  /** 가장 최근 BackupJob(상태 무관)의 status — 기록 없으면 null */
  lastBackupStatus: string | null;
  /** 가장 최근 BackupJob(상태 무관)의 시각 (completedAt ?? startedAt) */
  lastBackupAt: Date | null;
  /** 가장 최근 실패 백업 (없으면 null) */
  lastFailure: { at: Date; message: string | null } | null;
  /** 마지막 성공 이후 경과 시간(시간, 소수 1자리) — 성공 기록 없으면 null */
  ageHours: number | null;
  /** 성공 기록이 없거나 BACKUP_STALE_HOURS 초과 */
  stale: boolean;
  /** 판정 기준(시간) */
  thresholdHours: number;
}

/** BackupJob.metadata(JSON 문자열) 파싱 — 실패/비객체는 null */
export function parseBackupMetadata(
  raw: string | null | undefined,
): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 마지막 성공 이후 경과 시간(시간, 소수 1자리). 성공 기록 없으면 null */
export function backupAgeHours(
  lastSuccessfulBackupAt: Date | null,
  now: Date = new Date(),
): number | null {
  if (!lastSuccessfulBackupAt) return null;
  const hours = (now.getTime() - lastSuccessfulBackupAt.getTime()) / 3_600_000;
  return Math.max(0, Math.round(hours * 10) / 10);
}

/** 성공 기록 없음 또는 BACKUP_STALE_HOURS 초과 → true */
export function isBackupStale(
  lastSuccessfulBackupAt: Date | null,
  now: Date = new Date(),
): boolean {
  const age = backupAgeHours(lastSuccessfulBackupAt, now);
  return age === null || age > BACKUP_STALE_HOURS;
}

/** 바이트 → 사람이 읽는 크기 문자열 ('12.3 MB'). 숫자 아님/음수는 null */
export function formatBytes(bytes: unknown): string | null {
  const n = Number(bytes);
  if (bytes === null || bytes === undefined || !Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}

/**
 * 최신 BackupJob 기준 heartbeat 요약.
 * @param where 센터 스코프 — 정기 DB 백업은 전체 DB 대상(siteId NULL)이므로 센터 관리자 조회는
 *              호출자가 `OR:[{siteId},{siteId:null}]` 로 넘길 것 (함정 #11). 생략 시 전체.
 */
export async function loadBackupHeartbeat(
  prisma: PrismaService,
  where: Prisma.BackupJobWhereInput = {},
  now: Date = new Date(),
): Promise<BackupHeartbeat> {
  const [lastSuccess, latest, lastFailed] = await Promise.all([
    prisma.backupJob.findFirst({
      where: { ...where, status: BACKUP_JOB_STATUS.COMPLETED },
      orderBy: { completedAt: { sort: 'desc', nulls: 'last' } },
      select: { completedAt: true, startedAt: true },
    }),
    prisma.backupJob.findFirst({
      where,
      orderBy: { startedAt: 'desc' },
      select: { status: true, startedAt: true, completedAt: true },
    }),
    prisma.backupJob.findFirst({
      where: { ...where, status: BACKUP_JOB_STATUS.FAILED },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, completedAt: true, metadata: true },
    }),
  ]);

  const lastSuccessfulBackupAt = lastSuccess
    ? lastSuccess.completedAt ?? lastSuccess.startedAt
    : null;
  const ageHours = backupAgeHours(lastSuccessfulBackupAt, now);
  const failureMeta = parseBackupMetadata(lastFailed?.metadata);
  const failureMessage =
    typeof failureMeta?.message === 'string' && failureMeta.message.trim()
      ? failureMeta.message.trim()
      : null;

  return {
    lastSuccessfulBackupAt,
    lastBackupStatus: latest?.status ?? null,
    lastBackupAt: latest ? latest.completedAt ?? latest.startedAt : null,
    lastFailure: lastFailed
      ? { at: lastFailed.completedAt ?? lastFailed.startedAt, message: failureMessage }
      : null,
    ageHours,
    stale: ageHours === null || ageHours > BACKUP_STALE_HOURS,
    thresholdHours: BACKUP_STALE_HOURS,
  };
}
