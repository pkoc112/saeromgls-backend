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
  async create(dto: CreateInspectionDto, siteId: string, inspectedByWorkerId: string) {
    // 대상 작업 확인
    const workItem = await this.prisma.workItem.findUnique({
      where: { id: dto.sourceWorkItemId },
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

    const record = await this.prisma.inspectionRecord.create({
      data: {
        siteId,
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
