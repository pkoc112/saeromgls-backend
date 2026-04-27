import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { kstStartOfDay, kstEndOfDay } from '../common/kst-date.util';
import { CreateInspectionDto } from './dto/create-inspection.dto';
import { QueryInspectionDto } from './dto/query-inspection.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class InspectionService {
  private readonly logger = new Logger(InspectionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 검수 대기 목록: 당일 ENDED 작업 중 아직 검수되지 않은 항목
   */
  async getPendingItems(siteId: string | undefined, date?: string) {
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const from = kstStartOfDay(targetDate);
    const to = kstEndOfDay(targetDate);

    // 해당 날짜 ENDED 작업
    const where: Prisma.WorkItemWhereInput = {
      status: 'ENDED',
      endedAt: { gte: from, lte: to },
      ...(siteId && { startedByWorker: { OR: [{ siteId }, { siteId: null }] } }),
    };

    const allEnded = await this.prisma.workItem.findMany({
      where,
      select: {
        id: true,
        volume: true,
        quantity: true,
        startedAt: true,
        endedAt: true,
        classification: { select: { id: true, displayName: true } },
        startedByWorker: { select: { id: true, name: true, employeeCode: true } },
      },
      orderBy: { endedAt: 'desc' },
    });

    // 이미 검수된 workItemId 목록
    const inspected = await this.prisma.inspectionRecord.findMany({
      where: {
        sourceWorkItemId: { in: allEnded.map((w) => w.id) },
      },
      select: { sourceWorkItemId: true },
    });
    const inspectedIds = new Set(inspected.map((r) => r.sourceWorkItemId));

    // 미검수 항목만 반환
    const pending = allEnded.filter((w) => !inspectedIds.has(w.id));
    const done = allEnded.filter((w) => inspectedIds.has(w.id));

    return {
      date: targetDate,
      total: allEnded.length,
      pending: pending.map((w) => ({
        ...w,
        volume: Number(w.volume),
      })),
      pendingCount: pending.length,
      doneCount: done.length,
    };
  }

  /**
   * 일괄 검수: 당일 미검수 항목 전량 PASS + 이슈 개별 마킹
   */
  async batchInspect(
    siteId: string,
    dto: {
      inspectedByWorkerId: string;
      date: string;
      issues?: { workItemId: string; issueType: string; notes?: string }[];
    },
  ) {
    const pending = await this.getPendingItems(siteId, dto.date);
    if (pending.pendingCount === 0) {
      return { message: '검수 대기 항목이 없습니다', created: 0 };
    }

    const issueMap = new Map(
      (dto.issues || []).map((i) => [i.workItemId, i]),
    );

    const records = pending.pending.map((item) => {
      const issue = issueMap.get(item.id);
      return {
        siteId,
        sourceWorkItemId: item.id,
        inspectedByWorkerId: dto.inspectedByWorkerId,
        result: issue ? 'ISSUE' : 'PASS',
        issueType: issue?.issueType || null,
        quantityChecked: item.quantity,
        quantityDefect: issue ? item.quantity : 0,
        notes: issue?.notes || null,
      };
    });

    const created = await this.prisma.inspectionRecord.createMany({
      data: records,
    });

    this.logger.log(
      `Batch inspection: ${created.count} items (${dto.issues?.length || 0} issues) by ${dto.inspectedByWorkerId}`,
    );

    return {
      created: created.count,
      passCount: records.filter((r) => r.result === 'PASS').length,
      issueCount: records.filter((r) => r.result === 'ISSUE').length,
    };
  }

  /**
   * 검수 기록 목록 조회 (페이지네이션, 필터)
   */
  async findAll(siteId: string | undefined, params: QueryInspectionDto) {
    const page = params.page || 1;
    const limit = params.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.InspectionRecordWhereInput = {};

    // siteId 격리
    if (siteId) {
      where.siteId = siteId;
    }

    // 결과 필터
    if (params.status) {
      where.result = params.status;
    }

    // 날짜 범위 필터 (KST 기준)
    if (params.from || params.to) {
      where.inspectedAt = {};
      if (params.from) {
        where.inspectedAt.gte = kstStartOfDay(params.from);
      }
      if (params.to) {
        where.inspectedAt.lte = kstEndOfDay(params.to);
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.inspectionRecord.findMany({
        where,
        include: {
          sourceWorkItem: {
            select: {
              id: true,
              status: true,
              volume: true,
              quantity: true,
              classification: { select: { id: true, code: true, displayName: true } },
            },
          },
          inspectedBy: { select: { id: true, name: true, employeeCode: true } },
        },
        orderBy: { inspectedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.inspectionRecord.count({ where }),
    ]);

    return {
      data: data.map((r) => ({
        ...r,
        quantityChecked: Number(r.quantityChecked),
        quantityDefect: Number(r.quantityDefect),
      })),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * 검수 기록 생성 (종료된 작업 기준)
   */
  async create(
    dto: CreateInspectionDto,
    siteId: string | undefined,
    inspectedByWorkerId: string,
  ) {
    // 대상 작업 확인
    const workItem = await this.prisma.workItem.findUnique({
      where: { id: dto.sourceWorkItemId },
      include: { startedByWorker: { select: { siteId: true } } },
    });

    if (!workItem) {
      throw new NotFoundException('대상 작업을 찾을 수 없습니다');
    }

    if (workItem.status !== 'ENDED') {
      throw new BadRequestException('종료된 작업만 검수할 수 있습니다');
    }

    // 검수자 확인
    const inspector = await this.prisma.worker.findUnique({
      where: { id: inspectedByWorkerId },
    });
    if (!inspector || inspector.status !== 'ACTIVE') {
      throw new BadRequestException('유효하지 않은 검수자입니다');
    }

    // ★ siteId가 미지정이면 대상 작업 작업자의 siteId 사용 (MASTER 케이스)
    // 그래도 없으면 (legacy 작업자 siteId NULL) BadRequest로 거부 — 빈 문자열로 DB 오염 방지
    const effectiveSiteId = siteId || workItem.startedByWorker?.siteId;
    if (!effectiveSiteId) {
      throw new BadRequestException(
        '대상 작업의 사업장 정보를 알 수 없습니다 — 작업자에게 사업장을 배정해주세요',
      );
    }

    const record = await this.prisma.inspectionRecord.create({
      data: {
        siteId: effectiveSiteId,
        sourceWorkItemId: dto.sourceWorkItemId,
        inspectedByWorkerId,
        result: dto.result,
        issueType: dto.issueType,
        quantityChecked: dto.quantityChecked ?? 0,
        quantityDefect: dto.quantityDefect ?? 0,
        notes: dto.notes,
      },
      include: {
        sourceWorkItem: {
          select: {
            id: true,
            status: true,
            classification: { select: { id: true, code: true, displayName: true } },
          },
        },
        inspectedBy: { select: { id: true, name: true, employeeCode: true } },
      },
    });

    this.logger.log(`Inspection created: ${record.id} for workItem: ${dto.sourceWorkItemId}`);
    return record;
  }

  /**
   * 검수 통계: 커버리지, 정확도, SLA
   */
  async getStats(siteId: string | undefined, from?: string, to?: string) {
    const dateFilter: Prisma.InspectionRecordWhereInput = {};
    const workItemDateFilter: Prisma.WorkItemWhereInput = {};

    if (siteId) {
      dateFilter.siteId = siteId;
      workItemDateFilter.startedByWorker = {
        OR: [{ siteId }, { siteId: null }],
      };
    }

    if (from || to) {
      dateFilter.inspectedAt = {};
      workItemDateFilter.endedAt = {};
      if (from) {
        dateFilter.inspectedAt.gte = kstStartOfDay(from);
        (workItemDateFilter.endedAt as Prisma.DateTimeNullableFilter).gte = kstStartOfDay(from);
      }
      if (to) {
        dateFilter.inspectedAt.lte = kstEndOfDay(to);
        (workItemDateFilter.endedAt as Prisma.DateTimeNullableFilter).lte = kstEndOfDay(to);
      }
    }

    const [totalInspections, passCount, issueCount, recheckCount, totalEndedWorkItems] =
      await Promise.all([
        this.prisma.inspectionRecord.count({ where: dateFilter }),
        this.prisma.inspectionRecord.count({ where: { ...dateFilter, result: 'PASS' } }),
        this.prisma.inspectionRecord.count({ where: { ...dateFilter, result: 'ISSUE' } }),
        this.prisma.inspectionRecord.count({ where: { ...dateFilter, result: 'RECHECK' } }),
        this.prisma.workItem.count({
          where: { ...workItemDateFilter, status: 'ENDED' },
        }),
      ]);

    const coverage =
      totalEndedWorkItems > 0
        ? Number(((totalInspections / totalEndedWorkItems) * 100).toFixed(1))
        : 0;

    const accuracy =
      totalInspections > 0
        ? Number(((passCount / totalInspections) * 100).toFixed(1))
        : 0;

    return {
      totalInspections,
      totalEndedWorkItems,
      coverage,
      accuracy,
      byResult: {
        pass: passCount,
        issue: issueCount,
        recheck: recheckCount,
      },
    };
  }
}
