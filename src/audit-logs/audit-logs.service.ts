import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

export interface CreateAuditLogInput {
  actorWorkerId: string;
  workItemId?: string;
  action: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuditLogsService {
  private readonly logger = new Logger(AuditLogsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 감사 로그 생성
   * 작업 항목의 모든 변경 사항을 기록
   */
  async create(input: CreateAuditLogInput) {
    const log = await this.prisma.auditLog.create({
      data: {
        actorWorkerId: input.actorWorkerId,
        workItemId: input.workItemId,
        action: input.action,
        before: input.before ? JSON.stringify(input.before) : null,
        after: input.after ? JSON.stringify(input.after) : null,
        reason: input.reason,
        ip: input.ip,
        userAgent: input.userAgent,
      },
    });

    this.logger.log(
      `Audit: ${input.action} on workItem=${input.workItemId || 'N/A'} by ${input.actorWorkerId}`,
    );

    return log;
  }

  /**
   * 특정 작업 항목의 감사 로그 조회
   */
  async findByWorkItemId(workItemId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { workItemId },
        include: {
          actorWorker: {
            select: { id: true, name: true, employeeCode: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.auditLog.count({ where: { workItemId } }),
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
   * 전체 감사 로그 조회 (관리자 전용, 페이지네이션)
   * siteId 격리: actorWorker.siteId 기준 필터링
   */
  async findAll(params: {
    page?: number;
    limit?: number;
    workItemId?: string;
    actorWorkerId?: string;
    action?: string;
    siteId?: string;
  }) {
    const page = params.page || 1;
    const limit = params.limit || 50;
    const skip = (page - 1) * limit;

    const where: Prisma.AuditLogWhereInput = {};
    if (params.workItemId) where.workItemId = params.workItemId;
    if (params.actorWorkerId) where.actorWorkerId = params.actorWorkerId;
    if (params.action) where.action = params.action;

    // siteId 격리: actorWorker의 siteId 기준 (NULL 호환)
    if (params.siteId) {
      where.actorWorker = {
        OR: [{ siteId: params.siteId }, { siteId: null }],
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: {
          actorWorker: {
            select: { id: true, name: true, employeeCode: true },
          },
          workItem: {
            select: { id: true, status: true, startedAt: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
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
}
