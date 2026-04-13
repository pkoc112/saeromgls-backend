import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class DataProtectionService {
  private readonly logger = new Logger(DataProtectionService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── 백업 ──

  /**
   * 백업 상태 조회
   */
  async getBackupStatus(siteId?: string) {
    const where: Prisma.BackupJobWhereInput = {};
    if (siteId) {
      where.siteId = siteId;
    }

    // 최근 백업 목록 (최근 20건)
    const recentBackups = await this.prisma.backupJob.findMany({
      where,
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    // 마지막 성공 백업
    const lastSuccess = await this.prisma.backupJob.findFirst({
      where: { ...where, status: 'completed' },
      orderBy: { completedAt: 'desc' },
    });

    // 진행 중인 백업
    const inProgress = await this.prisma.backupJob.findFirst({
      where: { ...where, status: { in: ['pending', 'running'] } },
      orderBy: { startedAt: 'desc' },
    });

    return {
      recentBackups: recentBackups.map((b) => ({
        ...b,
        metadata: b.metadata ? (() => { try { return JSON.parse(b.metadata); } catch { return b.metadata; } })() : null,
      })),
      lastSuccessfulBackup: lastSuccess
        ? {
            id: lastSuccess.id,
            completedAt: lastSuccess.completedAt,
            type: lastSuccess.type,
          }
        : null,
      currentlyRunning: inProgress
        ? {
            id: inProgress.id,
            status: inProgress.status,
            startedAt: inProgress.startedAt,
          }
        : null,
    };
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
