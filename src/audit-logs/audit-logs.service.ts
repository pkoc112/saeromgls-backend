import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { kstStartOfDay, kstEndOfDay } from '../common/kst-date.util';

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

/** 강제종료는 action='END' + reason '[강제종료] ...' 로 기록됨 (work-items.service.forceEnd) */
export const FORCE_END_REASON_PREFIX = '[강제종료]';

/** 조회 필터로 허용하는 액션 (FORCE_END 는 END+prefix 의 가상 액션) */
export const AUDIT_ACTIONS = [
  'CREATE',
  'END',
  'FORCE_END',
  'PAUSE',
  'RESUME',
  'EDIT',
  'VOID',
  'RESTORE',
] as const;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
   * - siteId 격리: actorWorker.siteId 기준 (NULL 호환)
   * - from/to: KST 일자(YYYY-MM-DD) 기준 createdAt 범위
   * - action: CREATE/END/PAUSE/RESUME/EDIT/VOID/RESTORE + 가상 액션 FORCE_END(END + '[강제종료]' reason)
   */
  async findAll(params: {
    page?: number;
    limit?: number;
    workItemId?: string;
    actorWorkerId?: string;
    action?: string;
    siteId?: string;
    from?: string;
    to?: string;
  }) {
    // 쿼리 문자열이 그대로 올 수 있으므로 Number() 파싱 후 정수 보정 (limit 1~200 클램프)
    const page = Math.max(1, Math.floor(Number(params.page)) || 1);
    const limit = Math.min(Math.max(1, Math.floor(Number(params.limit)) || 50), 200);
    const skip = (page - 1) * limit;

    const where: Prisma.AuditLogWhereInput = {};
    if (params.workItemId) where.workItemId = params.workItemId;
    if (params.actorWorkerId) where.actorWorkerId = params.actorWorkerId;

    // 액션 필터 (대소문자 무관). FORCE_END 는 END + reason prefix 로 매핑
    const action = params.action?.trim().toUpperCase();
    if (action) {
      if (action === 'FORCE_END') {
        where.OR = [
          { action: 'FORCE_END' },
          { action: 'END', reason: { startsWith: FORCE_END_REASON_PREFIX } },
        ];
      } else {
        where.action = action;
      }
    }

    // 기간 필터 (KST 일자 기준 createdAt)
    if (params.from || params.to) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (params.from) {
        if (!DATE_ONLY_RE.test(params.from)) {
          throw new BadRequestException('from 은 YYYY-MM-DD 형식이어야 합니다');
        }
        createdAt.gte = kstStartOfDay(params.from);
      }
      if (params.to) {
        if (!DATE_ONLY_RE.test(params.to)) {
          throw new BadRequestException('to 는 YYYY-MM-DD 형식이어야 합니다');
        }
        createdAt.lte = kstEndOfDay(params.to);
      }
      if (createdAt.gte && createdAt.lte && createdAt.gte > createdAt.lte) {
        throw new BadRequestException('시작일이 종료일보다 늦을 수 없습니다');
      }
      where.createdAt = createdAt;
    }

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
            select: {
              id: true,
              status: true,
              startedAt: true,
              classification: { select: { id: true, code: true, displayName: true } },
              startedByWorker: { select: { id: true, name: true } },
            },
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
