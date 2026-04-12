import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { CreateIncentivePolicyDto } from './dto/create-incentive-policy.dto';
import { UpdateIncentivePolicyDto } from './dto/update-incentive-policy.dto';
import { kstDateRange } from '../common/kst-date.util';

export interface WorkerRanking {
  workerId: string;
  workerName: string;
  employeeCode: string;
  completedCount: number;
  totalVolume: number;
  totalQuantity: number;
  avgDurationMinutes: number | null;
  productivityScore: number;
  estimatedIncentive: number;
}

@Injectable()
export class PerformanceService {
  private readonly logger = new Logger(PerformanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 작업자별 생산성 랭킹 조회
   * ENDED 작업 기준, 작업자별 집계
   */
  async getRankings(
    siteId: string | undefined,
    from: string,
    to: string,
    sortBy: string = 'score',
  ) {
    const { fromDate, toDate } = kstDateRange(from, to);

    // 인센티브 정책 조회
    const policy = siteId
      ? await this.prisma.incentivePolicy.findFirst({
          where: { siteId, isActive: true },
          orderBy: { createdAt: 'desc' },
        })
      : null;

    const weightCount = policy?.scoreWeightCount ?? 10;
    const weightVolume = policy?.scoreWeightVolume ?? 2;
    const weightQuantity = policy?.scoreWeightQuantity ?? 0.05;

    // 사업장 필터 조건
    const siteFilter = siteId
      ? Prisma.sql`AND w.site_id = ${siteId}`
      : Prisma.empty;

    // 작업자별 집계 (시작자 + 공동작업자 모두 포함)
    // UNION으로 시작자와 공동작업자를 합친 후 작업자별 집계
    const rankings = await this.prisma.$queryRaw<
      {
        worker_id: string;
        worker_name: string;
        employee_code: string;
        completed_count: bigint;
        total_volume: number;
        total_quantity: bigint;
        avg_duration_minutes: number | null;
        co_work_count: bigint;
      }[]
    >`
      WITH all_participations AS (
        -- 시작자 (주 작업자)
        SELECT wi.id as work_item_id, wi.started_by_worker_id as worker_id,
               wi.volume, wi.quantity, wi.started_at, wi.ended_at, false as is_coworker
        FROM work_items wi
        WHERE wi.status = 'ENDED' AND wi.ended_at IS NOT NULL
          AND wi.started_at >= ${fromDate} AND wi.started_at <= ${toDate}
          ${siteFilter}
        UNION ALL
        -- 공동 작업자
        SELECT wi.id as work_item_id, wa.worker_id,
               wi.volume, wi.quantity, wi.started_at, wi.ended_at, true as is_coworker
        FROM work_items wi
        JOIN work_assignments wa ON wa.work_item_id = wi.id AND wa.role != 'STARTER'
        WHERE wi.status = 'ENDED' AND wi.ended_at IS NOT NULL
          AND wi.started_at >= ${fromDate} AND wi.started_at <= ${toDate}
          ${siteFilter}
      )
      SELECT
        w.id as worker_id,
        w.name as worker_name,
        w.employee_code,
        COUNT(DISTINCT ap.work_item_id) as completed_count,
        COALESCE(SUM(ap.volume), 0) as total_volume,
        COALESCE(SUM(ap.quantity), 0) as total_quantity,
        AVG(EXTRACT(EPOCH FROM (ap.ended_at - ap.started_at)) / 60.0) as avg_duration_minutes,
        COUNT(DISTINCT CASE WHEN ap.is_coworker THEN ap.work_item_id END) as co_work_count
      FROM all_participations ap
      JOIN workers w ON w.id = ap.worker_id
      GROUP BY w.id, w.name, w.employee_code
      ORDER BY completed_count DESC
    `;

    // 생산성 점수 및 인센티브 계산
    const result: WorkerRanking[] = rankings.map((r) => {
      const count = Number(r.completed_count);
      const volume = Number(r.total_volume);
      const quantity = Number(r.total_quantity);
      const avgDuration = r.avg_duration_minutes
        ? Math.round(Number(r.avg_duration_minutes) * 100) / 100
        : null;

      const productivityScore =
        Math.round(
          (count * weightCount + volume * weightVolume + quantity * weightQuantity) * 100,
        ) / 100;

      // 인센티브 계산
      let estimatedIncentive = 0;
      if (policy) {
        if (
          policy.bonusThreshold2 != null &&
          policy.bonusAmount2 != null &&
          productivityScore >= policy.bonusThreshold2
        ) {
          estimatedIncentive = policy.bonusAmount2;
        } else if (
          policy.bonusThreshold1 != null &&
          policy.bonusAmount1 != null &&
          productivityScore >= policy.bonusThreshold1
        ) {
          estimatedIncentive = policy.bonusAmount1;
        }
      }

      return {
        workerId: r.worker_id,
        workerName: r.worker_name,
        employeeCode: r.employee_code,
        completedCount: count,
        totalVolume: volume,
        totalQuantity: quantity,
        avgDurationMinutes: avgDuration,
        productivityScore,
        estimatedIncentive,
        coWorkCount: Number(r.co_work_count || 0),
      };
    });

    // 정렬
    switch (sortBy) {
      case 'count':
        result.sort((a, b) => b.completedCount - a.completedCount);
        break;
      case 'volume':
        result.sort((a, b) => b.totalVolume - a.totalVolume);
        break;
      case 'quantity':
        result.sort((a, b) => b.totalQuantity - a.totalQuantity);
        break;
      case 'duration':
        result.sort((a, b) => (a.avgDurationMinutes ?? 999) - (b.avgDurationMinutes ?? 999));
        break;
      case 'score':
      default:
        result.sort((a, b) => b.productivityScore - a.productivityScore);
        break;
    }

    return {
      period: { from, to },
      policy: policy
        ? {
            name: policy.name,
            weightCount: policy.scoreWeightCount,
            weightVolume: policy.scoreWeightVolume,
            weightQuantity: policy.scoreWeightQuantity,
          }
        : { name: '기본', weightCount: 10, weightVolume: 2, weightQuantity: 0.05 },
      rankings: result,
    };
  }

  /**
   * 전체 요약 통계
   */
  async getSummary(siteId: string | undefined, from: string, to: string) {
    const { fromDate, toDate } = kstDateRange(from, to);

    const dateFilter: Prisma.WorkItemWhereInput = {
      startedAt: { gte: fromDate, lte: toDate },
      status: 'ENDED',
      ...(siteId && { startedByWorker: { siteId } }),
    };

    const aggregates = await this.prisma.workItem.aggregate({
      where: dateFilter,
      _sum: { volume: true, quantity: true },
      _count: true,
    });

    // 고유 작업자 수
    const distinctWorkers = await this.prisma.workItem.findMany({
      where: dateFilter,
      select: { startedByWorkerId: true },
      distinct: ['startedByWorkerId'],
    });

    // 인센티브 정책으로 평균 점수 계산
    const policy = siteId
      ? await this.prisma.incentivePolicy.findFirst({
          where: { siteId, isActive: true },
          orderBy: { createdAt: 'desc' },
        })
      : null;

    const weightCount = policy?.scoreWeightCount ?? 10;
    const weightVolume = policy?.scoreWeightVolume ?? 2;
    const weightQuantity = policy?.scoreWeightQuantity ?? 0.05;

    const totalCount = aggregates._count;
    const totalVolume = Number(aggregates._sum.volume ?? 0);
    const totalQuantity = aggregates._sum.quantity ?? 0;
    const workerCount = distinctWorkers.length;

    const avgScore =
      workerCount > 0
        ? Math.round(
            ((totalCount * weightCount + totalVolume * weightVolume + totalQuantity * weightQuantity) /
              workerCount) *
              100,
          ) / 100
        : 0;

    return {
      period: { from, to },
      totalWorkers: workerCount,
      totalCount,
      totalVolume,
      totalQuantity,
      avgScore,
    };
  }

  // ── 인센티브 정책 CRUD ──

  async getIncentivePolicies(siteId: string) {
    return this.prisma.incentivePolicy.findMany({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createIncentivePolicy(dto: CreateIncentivePolicyDto) {
    return this.prisma.incentivePolicy.create({
      data: {
        siteId: dto.siteId,
        name: dto.name,
        scoreWeightCount: dto.scoreWeightCount ?? 10,
        scoreWeightVolume: dto.scoreWeightVolume ?? 2,
        scoreWeightQuantity: dto.scoreWeightQuantity ?? 0.05,
        bonusThreshold1: dto.bonusThreshold1,
        bonusAmount1: dto.bonusAmount1,
        bonusThreshold2: dto.bonusThreshold2,
        bonusAmount2: dto.bonusAmount2,
      },
    });
  }

  async updateIncentivePolicy(id: string, dto: UpdateIncentivePolicyDto) {
    const { siteId, ...updateData } = dto;
    return this.prisma.incentivePolicy.update({
      where: { id },
      data: updateData,
    });
  }
}
