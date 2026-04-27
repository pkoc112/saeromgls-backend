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
   * - siteId 필수 (controller에서 가드됨)
   * - 검수자 존재 + ACTIVE 사전 검증
   * - 사이트 존재 사전 검증
   * - Prisma FK 위반은 BadRequest로 변환하여 한국어 메시지 노출
   */
  async batchInspect(
    siteId: string,
    dto: {
      inspectedByWorkerId: string;
      date: string;
      issues?: { workItemId: string; issueType: string; notes?: string }[];
    },
  ) {
    // ★ 사전 검증 1: 사업장 존재 확인 (FK 위반 방지)
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) {
      throw new BadRequestException('지정된 사업장을 찾을 수 없습니다');
    }

    // ★ 사전 검증 2: 검수자 존재 + ACTIVE
    const inspector = await this.prisma.worker.findUnique({
      where: { id: dto.inspectedByWorkerId },
      select: { id: true, name: true, status: true, role: true, siteId: true },
    });
    if (!inspector) {
      throw new BadRequestException('지정한 검수자를 찾을 수 없습니다');
    }
    if (inspector.status !== 'ACTIVE') {
      throw new BadRequestException(
        `검수자(${inspector.name})는 비활성 상태입니다. 활성 작업자를 선택해주세요`,
      );
    }
    // 검수자 사업장과 일괄검수 대상 사업장 매칭 (legacy NULL 허용)
    if (inspector.siteId && inspector.siteId !== siteId) {
      throw new BadRequestException(
        `검수자(${inspector.name})는 다른 사업장 소속입니다. 같은 사업장 작업자만 검수할 수 있습니다`,
      );
    }

    // ★ 사전 검증 3: 미검수 항목 존재 확인
    const pending = await this.getPendingItems(siteId, dto.date);
    if (pending.pendingCount === 0) {
      // 200으로 정상 응답하되 created=0 명시 (UI에서 명확히 표시)
      return {
        message: `${dto.date}에 검수 대기 항목이 없습니다`,
        created: 0,
        passCount: 0,
        issueCount: 0,
      };
    }

    // ★ 사전 검증 4: 이슈 목록의 workItemId가 모두 미검수 대기 목록에 있는지 확인
    if (dto.issues && dto.issues.length > 0) {
      const pendingIds = new Set(pending.pending.map((p) => p.id));
      const invalidIssues = dto.issues.filter((i) => !pendingIds.has(i.workItemId));
      if (invalidIssues.length > 0) {
        throw new BadRequestException(
          `이슈 마킹된 ${invalidIssues.length}건이 검수 대기 목록에 없습니다 (이미 검수됐거나 다른 사업장 작업)`,
        );
      }
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

    try {
      const created = await this.prisma.inspectionRecord.createMany({
        data: records,
      });

      this.logger.log(
        `Batch inspection: ${created.count} items (${dto.issues?.length || 0} issues) by ${dto.inspectedByWorkerId} for site ${siteId}`,
      );

      return {
        created: created.count,
        passCount: records.filter((r) => r.result === 'PASS').length,
        issueCount: records.filter((r) => r.result === 'ISSUE').length,
      };
    } catch (err: any) {
      // Prisma FK/unique 에러를 한국어 BadRequest로 변환 (사전 검증으로 거의 발생 안 하지만 안전망)
      if (err?.code === 'P2003') {
        throw new BadRequestException(
          '검수 데이터 저장 실패: 외래키 제약 위반 (사업장/검수자/작업 데이터를 확인해주세요)',
        );
      }
      if (err?.code === 'P2002') {
        throw new BadRequestException(
          '동일한 작업에 대한 검수 기록이 이미 존재합니다',
        );
      }
      this.logger.error('Batch inspection failed', err);
      throw err;
    }
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
