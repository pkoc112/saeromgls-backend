import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import {
  BACKUP_JOB_STATUS,
  BackupHeartbeat,
  formatBytes,
  loadBackupHeartbeat,
  parseBackupMetadata,
} from '../common/utils/backup-heartbeat';

/** 웹(data-protection/page.tsx) BackupStatus.status */
type BackupHealthStatus = 'healthy' | 'warning' | 'error';
/** 웹 BackupRecord.status — DB pending/running 은 in_progress 로 합침 */
type BackupRecordStatus = 'completed' | 'failed' | 'in_progress';

@Injectable()
export class DataProtectionService {
  private readonly logger = new Logger(DataProtectionService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── 백업 ──

  /**
   * 백업 상태 조회 (#49 heartbeat 기준)
   * - 응답 필드명은 웹 data-protection/page.tsx 인터페이스와 동일:
   *   status/message/lastSuccessfulBackupAt/lastBackupStatus/lastBackupAt/ageHours/thresholdHours/backups[]
   * - 정기 DB 백업(GitHub Actions heartbeat)은 전체 DB 대상이라 siteId NULL → 센터 관리자 조회도
   *   OR:[{siteId},{siteId:null}] 로 포함 (함정 #11). MASTER(siteId 없음)는 전체.
   */
  async getBackupStatus(siteId?: string) {
    const where: Prisma.BackupJobWhereInput = siteId
      ? { OR: [{ siteId }, { siteId: null }] }
      : {};
    const now = new Date();

    const [recentBackups, heartbeat, inProgress] = await Promise.all([
      // 최근 백업 목록 (최근 20건)
      this.prisma.backupJob.findMany({
        where,
        include: {
          site: { select: { id: true, name: true, code: true } },
        },
        orderBy: { startedAt: 'desc' },
        take: 20,
      }),
      // 마지막 성공 / 최근 상태 / 지연 여부 — cron·health 와 동일 계산
      loadBackupHeartbeat(this.prisma, where, now),
      // 진행 중인 백업
      this.prisma.backupJob.findFirst({
        where: {
          ...where,
          status: { in: [BACKUP_JOB_STATUS.PENDING, BACKUP_JOB_STATUS.RUNNING] },
        },
        orderBy: { startedAt: 'desc' },
        select: { id: true, status: true, startedAt: true, type: true },
      }),
    ]);

    const { status, message } = this.evaluateBackupHealth(heartbeat);

    return {
      status,
      message,
      lastSuccessfulBackupAt: heartbeat.lastSuccessfulBackupAt,
      lastBackupStatus: heartbeat.lastBackupStatus,
      lastBackupAt: heartbeat.lastBackupAt,
      ageHours: heartbeat.ageHours,
      thresholdHours: heartbeat.thresholdHours,
      currentlyRunning: inProgress
        ? {
            id: inProgress.id,
            status: inProgress.status,
            startedAt: inProgress.startedAt,
            type: inProgress.type,
          }
        : null,
      backups: recentBackups.map((b) => {
        const meta = parseBackupMetadata(b.metadata);
        const rawSize = meta?.sizeBytes;
        const sizeBytes =
          rawSize === null || rawSize === undefined || !Number.isFinite(Number(rawSize))
            ? null
            : Number(rawSize);
        return {
          id: b.id,
          date: b.completedAt ?? b.startedAt,
          startedAt: b.startedAt,
          completedAt: b.completedAt,
          type: b.type,
          status: this.toRecordStatus(b.status),
          sizeBytes,
          size: formatBytes(sizeBytes),
          message: typeof meta?.message === 'string' ? meta.message : null,
          site: b.site,
        };
      }),
    };
  }

  /** heartbeat → 웹 보호 상태(healthy/warning/error) + 한국어 안내 문구 */
  private evaluateBackupHealth(hb: BackupHeartbeat): {
    status: BackupHealthStatus;
    message: string | null;
  } {
    if (hb.lastSuccessfulBackupAt === null) {
      return {
        status: 'warning',
        message:
          '성공한 백업 기록이 없습니다. GitHub Actions 일간 백업의 heartbeat 연동(API_BASE_URL/CRON_SECRET)을 확인하세요.',
      };
    }
    if (hb.stale) {
      return {
        status: 'error',
        message: `마지막 성공 백업이 ${hb.ageHours}시간 전입니다 (기준 ${hb.thresholdHours}시간). 백업 워크플로를 확인하세요.`,
      };
    }
    if (hb.lastBackupStatus === BACKUP_JOB_STATUS.FAILED) {
      const detail = hb.lastFailure?.message ? `: ${hb.lastFailure.message}` : '';
      return {
        status: 'warning',
        message: `최근 백업 시도가 실패했습니다${detail}. 마지막 성공 백업은 ${hb.ageHours}시간 전입니다.`,
      };
    }
    return { status: 'healthy', message: null };
  }

  /** DB status 문자열 → 웹 표시 상태 (pending/running → in_progress) */
  private toRecordStatus(status: string): BackupRecordStatus {
    const s = String(status || '').toLowerCase();
    if (s === BACKUP_JOB_STATUS.COMPLETED) return 'completed';
    if (s === BACKUP_JOB_STATUS.FAILED) return 'failed';
    return 'in_progress';
  }

  /**
   * 백업 요청 생성
   */
  async requestBackup(siteId?: string, type = 'manual') {
    // 이미 진행 중인 백업이 있는지 확인
    const existing = await this.prisma.backupJob.findFirst({
      where: {
        ...(siteId && { siteId }),
        status: { in: ['pending', 'running'] },
      },
    });

    if (existing) {
      return {
        success: false,
        message: '이미 진행 중인 백업 작업이 있습니다',
        existingJob: {
          id: existing.id,
          status: existing.status,
          startedAt: existing.startedAt,
        },
      };
    }

    const job = await this.prisma.backupJob.create({
      data: {
        siteId,
        type,
        status: 'pending',
        metadata: JSON.stringify({
          requestedAt: new Date().toISOString(),
          description: type === 'manual' ? '수동 백업 요청' : '자동 백업',
        }),
      },
    });

    this.logger.log(`Backup requested: ${job.id} (type=${type}, siteId=${siteId || 'ALL'})`);

    return {
      success: true,
      message: '백업이 요청되었습니다',
      job: {
        id: job.id,
        status: job.status,
        type: job.type,
        startedAt: job.startedAt,
      },
    };
  }

  // ── 복원 요청 ──

  /**
   * 복원 요청 목록 조회
   */
  async getRestoreRequests(
    siteId?: string,
    filters?: { status?: string; page?: number; limit?: number },
  ) {
    const page = filters?.page || 1;
    const limit = Math.min(filters?.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.RestoreRequestWhereInput = {};
    if (siteId) {
      where.siteId = siteId;
    }
    if (filters?.status) {
      where.status = filters.status;
    }

    const [data, total] = await Promise.all([
      this.prisma.restoreRequest.findMany({
        where,
        include: {
          site: { select: { id: true, name: true, code: true } },
          requestedBy: {
            select: { id: true, name: true, employeeCode: true, role: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.restoreRequest.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * 복원 요청 생성
   */
  async createRestoreRequest(data: {
    siteId: string;
    requestedByWorkerId: string;
    reason: string;
  }) {
    // 이미 대기 중인 복원 요청이 있는지 확인
    const pendingRequest = await this.prisma.restoreRequest.findFirst({
      where: {
        siteId: data.siteId,
        status: 'requested',
      },
    });

    if (pendingRequest) {
      return {
        success: false,
        message: '이미 대기 중인 복원 요청이 있습니다',
        existingRequest: {
          id: pendingRequest.id,
          status: pendingRequest.status,
          createdAt: pendingRequest.createdAt,
        },
      };
    }

    const request = await this.prisma.restoreRequest.create({
      data: {
        siteId: data.siteId,
        requestedByWorkerId: data.requestedByWorkerId,
        reason: data.reason,
      },
      include: {
        site: { select: { id: true, name: true } },
        requestedBy: { select: { id: true, name: true, employeeCode: true } },
      },
    });

    this.logger.log(
      `Restore request created: ${request.id} by ${data.requestedByWorkerId} for site ${data.siteId}`,
    );

    return {
      success: true,
      message: '복원 요청이 접수되었습니다',
      request,
    };
  }
}
