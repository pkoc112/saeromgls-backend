import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

export interface LogActivityInput {
  siteId?: string;
  actorWorkerId: string;
  actionType: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class ActivityLogsService {
  private readonly logger = new Logger(ActivityLogsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 관리자 활동 기록
   */
  async logActivity(input: LogActivityInput) {
    const log = await this.prisma.adminActivityLog.create({
      data: {
        siteId: input.siteId,
        actorWorkerId: input.actorWorkerId,
        actionType: input.actionType,
        targetType: input.targetType,
        targetId: input.targetId,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
    });

    this.logger.log(
      `AdminActivity: ${input.actionType} by ${input.actorWorkerId} on ${input.targetType || 'N/A'}/${input.targetId || 'N/A'}`,
    );

    return log;
  }

  /**
   * 관리자 활동 로그 조회 (페이지네이션, 필터)
   */
  async getActivityLogs(
    siteId: string | undefined,
    filters: {
      from?: string;
      to?: string;
      actionType?: string;
      actorWorkerId?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 50, 100);
    const skip = (page - 1) * limit;

    const where: Prisma.AdminActivityLogWhereInput = {};

    if (siteId) {
      where.siteId = siteId;
    }

    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) {
        where.createdAt.gte = new Date(filters.from);
      }
      if (filters.to) {
        const toDate = new Date(filters.to);
        toDate.setHours(23, 59, 59, 999);
        where.createdAt.lte = toDate;
      }
    }

    if (filters.actionType) {
      where.actionType = filters.actionType;
    }

    if (filters.actorWorkerId) {
      where.actorWorkerId = filters.actorWorkerId;
    }

    const [data, total] = await Promise.all([
      this.prisma.adminActivityLog.findMany({
        where,
        include: {
          actorWorker: {
            select: { id: true, name: true, employeeCode: true, role: true },
          },
          site: {
            select: { id: true, name: true, code: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.adminActivityLog.count({ where }),
    ]);

    return {
      data: data.map((log) => ({
        ...log,
        metadata: log.metadata ? (() => { try { return JSON.parse(log.metadata); } catch { return log.metadata; } })() : null,
      })),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
