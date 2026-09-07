import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { CreateIncentivePolicyDto } from './dto/create-incentive-policy.dto';
import { UpdateIncentivePolicyDto } from './dto/update-incentive-policy.dto';
import { kstDateRange } from '../common/kst-date.util';
import {
  calcNetWorkMinutes,
  loadBreakConfigResolver,
} from '../common/utils/net-work-minutes';

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

    // 사업장 필터: CTE 이후 workers JOIN 시점에 적용 (NULL 작업자 포함 — 함정 #11)
    const workerSiteFilter = siteId
      ? Prisma.sql`WHERE (w.site_id = ${siteId} OR w.site_id IS NULL)`
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
        UNION ALL
        -- 공동 작업자
        SELECT wi.id as work_item_id, wa.worker_id,
               wi.volume, wi.quantity, wi.started_at, wi.ended_at, true as is_coworker
        FROM work_items wi
        JOIN work_assignments wa ON wa.work_item_id = wi.id AND wa.role != 'STARTER'
        WHERE wi.status = 'ENDED' AND wi.ended_at IS NOT NULL
          AND wi.started_at >= ${fromDate} AND wi.started_at <= ${toDate}
      )
      SELECT
        w.id as worker_id,
        w.name as worker_name,
        w.employee_code,
        COUNT(DISTINCT ap.work_item_id) as completed_count,
        COALESCE(SUM(ap.volume), 0) as total_volume,
        COALESCE(SUM(ap.quantity), 0) as total_quantity,
        COUNT(DISTINCT CASE WHEN ap.is_coworker THEN ap.work_item_id END) as co_work_count
      FROM all_participations ap
      JOIN workers w ON w.id = ap.worker_id
      ${workerSiteFilter}
      GROUP BY w.id, w.name, w.employee_code
      ORDER BY completed_count DESC
    `;

    // 작업자별 평균 순작업시간 — 행 fetch 후 JS calcNetWorkMinutes 집계 (#33)
    // (SQL AVG(ended_at - started_at) 대체: 중간마감·휴게시간 차감 반영, 반올림 Math.round)
    const avgDurationMap = await this.buildAvgNetMinutesByWorker(fromDate, toDate, siteId);

    // 생산성 점수 및 인센티브 계산
    const result: WorkerRanking[] = rankings.map((r) => {
      const count = Number(r.completed_count);
      const volume = Number(r.total_volume);
      const quantity = Number(r.total_quantity);
      const avgDuration = avgDurationMap.get(r.worker_id) ?? null;

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
   * 기간 내 종료 작업의 작업자별 평균 순작업시간(분) 맵 (시작자 + 공동작업자 모두 포함)
   * - 순작업시간 = 총 시간 − 중간마감 − 휴게시간 겹침 (calcNetWorkMinutes)
   * - 휴게시간은 작업이 발생한 사업장(시작 작업자 siteId) 기준, NULL 작업자는 전역 설정
   * - 행 수가 많을 수 있어 최소 컬럼만 select
   */
  private async buildAvgNetMinutesByWorker(
    fromDate: Date,
    toDate: Date,
    siteId?: string,
  ): Promise<Map<string, number>> {
    const rows = await this.prisma.workItem.findMany({
      where: {
        status: 'ENDED',
        endedAt: { not: null },
        startedAt: { gte: fromDate, lte: toDate },
        ...(siteId && { startedByWorker: { OR: [{ siteId }, { siteId: null }] } }),
      },
      select: {
        id: true,
        startedByWorkerId: true,
        startedAt: true,
        endedAt: true,
        notes: true,
        startedByWorker: { select: { siteId: true } },
        assignments: {
          where: { role: { not: 'STARTER' } },
          select: { workerId: true },
        },
      },
    });

    const breaks = await loadBreakConfigResolver(this.prisma, [
      siteId,
      ...rows.map((r) => r.startedByWorker?.siteId),
    ]);

    const agg = new Map<string, { sum: number; count: number }>();
    const add = (workerId: string, minutes: number) => {
      const cur = agg.get(workerId) ?? { sum: 0, count: 0 };
      cur.sum += minutes;
      cur.count += 1;
      agg.set(workerId, cur);
    };

    for (const r of rows) {
      const minutes = calcNetWorkMinutes(
        r.startedAt,
        r.endedAt,
        r.notes,
        breaks.forSite(r.startedByWorker?.siteId),
      );
      // 시작자 + 공동작업자(중복 제거) 모두 해당 작업의 순작업시간을 가짐
      const participants = new Set<string>([
        r.startedByWorkerId,
        ...r.assignments.map((a) => a.workerId),
      ]);
      participants.forEach((wid) => add(wid, minutes));
    }

    const result = new Map<string, number>();
    agg.forEach((v, wid) => {
      if (v.count > 0) result.set(wid, Math.round(v.sum / v.count));
    });
    return result;
  }

  /**
   * 전체 요약 통계
   */
  async getSummary(siteId: string | undefined, from: string, to: string) {
    const { fromDate, toDate } = kstDateRange(from, to);

    const dateFilter: Prisma.WorkItemWhereInput = {
      startedAt: { gte: fromDate, lte: toDate },
      status: 'ENDED',
      ...(siteId && { startedByWorker: { OR: [{ siteId }, { siteId: null }] } }),
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

    // 작업자별 평균 기반 생산성 점수 (전체 합계가 아닌 1인당 평균)
    const avgCount = workerCount > 0 ? totalCount / workerCount : 0;
    const avgVolume = workerCount > 0 ? totalVolume / workerCount : 0;
    const avgQuantity = workerCount > 0 ? Number(totalQuantity) / workerCount : 0;
    const avgScore =
      Math.round(
        (avgCount * weightCount + avgVolume * weightVolume + avgQuantity * weightQuantity) * 100,
      ) / 100;

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

  async updateIncentivePolicy(
    id: string,
    dto: UpdateIncentivePolicyDto,
    siteId?: string,
  ) {
    // ★ IDOR 방어: 정책 소유권 검증 (다른 사업장 정책이면 없는 것처럼 차단)
    const existing = await this.prisma.incentivePolicy.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('인센티브 정책을 찾을 수 없습니다');
    }
    if (siteId && existing.siteId !== siteId) {
      throw new NotFoundException('인센티브 정책을 찾을 수 없습니다');
    }
    const { siteId: _ignore, ...updateData } = dto;
    return this.prisma.incentivePolicy.update({
      where: { id },
      data: updateData,
    });
  }
}
