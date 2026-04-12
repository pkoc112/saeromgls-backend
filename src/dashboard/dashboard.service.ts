import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { kstDateRange } from '../common/kst-date.util';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * KPI 통계 조회
   * 기간별 작업 건수, 총 물량, 평균 작업 시간, 작업자별 통계 등
   */
  async getStats(from: string, to: string, siteId?: string) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    const dateFilter: Prisma.WorkItemWhereInput = {
      startedAt: { gte: fromDate, lte: toDate },
      ...(siteId && { startedByWorker: { siteId } }),
    };

    // 전체 건수 (상태별)
    const [totalActive, totalEnded, totalVoid] = await Promise.all([
      this.prisma.workItem.count({ where: { ...dateFilter, status: 'ACTIVE' } }),
      this.prisma.workItem.count({ where: { ...dateFilter, status: 'ENDED' } }),
      this.prisma.workItem.count({ where: { ...dateFilter, status: 'VOID' } }),
    ]);

    // 총 물량/수량 (종료된 작업 기준)
    const aggregates = await this.prisma.workItem.aggregate({
      where: { ...dateFilter, status: 'ENDED' },
      _sum: { volume: true, quantity: true },
      _avg: { volume: true, quantity: true },
      _count: true,
    });

    // 분류별 통계
    const byClassification = await this.prisma.workItem.groupBy({
      by: ['classificationId'],
      where: { ...dateFilter, status: { not: 'VOID' } },
      _count: true,
      _sum: { volume: true, quantity: true },
    });

    // 분류 이름 매핑
    const classificationIds = byClassification.map((c) => c.classificationId);
    const classifications = await this.prisma.classification.findMany({
      where: { id: { in: classificationIds } },
      select: { id: true, code: true, displayName: true },
    });
    const classMap = new Map(classifications.map((c) => [c.id, c]));

    const classificationStats = byClassification.map((c) => ({
      classification: classMap.get(c.classificationId) || { id: c.classificationId },
      count: c._count,
      totalVolume: c._sum.volume,
      totalQuantity: c._sum.quantity,
    }));

    // 작업자별 통계 (상위 10명)
    const byWorker = await this.prisma.workItem.groupBy({
      by: ['startedByWorkerId'],
      where: { ...dateFilter, status: { not: 'VOID' } },
      _count: true,
      _sum: { volume: true, quantity: true },
      orderBy: { _count: { startedByWorkerId: 'desc' } },
      take: 10,
    });

    const workerIds = byWorker.map((w) => w.startedByWorkerId);
    const workers = await this.prisma.worker.findMany({
      where: { id: { in: workerIds } },
      select: { id: true, name: true, employeeCode: true },
    });
    const workerMap = new Map(workers.map((w) => [w.id, w]));

    const workerStats = byWorker.map((w) => ({
      worker: workerMap.get(w.startedByWorkerId) || { id: w.startedByWorkerId },
      count: w._count,
      totalVolume: w._sum.volume,
      totalQuantity: w._sum.quantity,
    }));

    // 평균 작업 시간 (종료된 작업, 분 단위) -- raw SQL로 계산
    let avgDurationMinutes: number | null = null;
    try {
      const durationResult = await this.prisma.$queryRaw<
        { avg_minutes: number }[]
      >`
        SELECT AVG((strftime('%s', ended_at) - strftime('%s', started_at)) / 60.0) as avg_minutes
        FROM work_items
        WHERE started_at >= ${fromDate.toISOString()}
          AND started_at <= ${toDate.toISOString()}
          AND status = 'ENDED'
          AND ended_at IS NOT NULL
      `;
      avgDurationMinutes = durationResult[0]?.avg_minutes
        ? Math.round(durationResult[0].avg_minutes * 100) / 100
        : null;
    } catch (err) {
      this.logger.warn('Failed to compute avg duration', err);
    }

    return {
      period: { from, to },
      counts: {
        active: totalActive,
        ended: totalEnded,
        void: totalVoid,
        total: totalActive + totalEnded + totalVoid,
      },
      aggregates: {
        totalVolume: aggregates._sum.volume,
        totalQuantity: aggregates._sum.quantity,
        avgVolume: aggregates._avg.volume,
        avgQuantity: aggregates._avg.quantity,
        endedCount: aggregates._count,
      },
      avgDurationMinutes,
      byClassification: classificationStats,
      topWorkers: workerStats,
    };
  }

  /**
   * 트렌드 데이터 (차트용)
   * 일별/주별/월별 그룹핑
   */
  async getTrends(from: string, to: string, groupBy: 'hour' | 'day' | 'week' | 'month' = 'day', siteId?: string) {
    const { fromDate, toDate } = kstDateRange(from, to);

    // PostgreSQL date_trunc / to_char — KST 타임존 기준
    let dateExpr: string;
    switch (groupBy) {
      case 'hour':
        dateExpr = `to_char(started_at AT TIME ZONE 'Asia/Seoul', 'HH24')`;
        break;
      case 'week':
        dateExpr = `to_char(date_trunc('week', started_at AT TIME ZONE 'Asia/Seoul'), 'YYYY-"W"IW')`;
        break;
      case 'month':
        dateExpr = `to_char(date_trunc('month', started_at AT TIME ZONE 'Asia/Seoul'), 'YYYY-MM-DD')`;
        break;
      default:
        dateExpr = `to_char(started_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`;
    }

    const siteFilter = siteId
      ? `AND started_by_worker_id IN (SELECT id FROM workers WHERE site_id = $3)`
      : '';
    const queryParams: any[] = [fromDate.toISOString(), toDate.toISOString()];
    if (siteId) queryParams.push(siteId);

    try {
      const trends = await this.prisma.$queryRawUnsafe<
        { period: string; count: bigint; total_volume: number; total_quantity: bigint }[]
      >(
        `SELECT
          ${dateExpr} as period,
          COUNT(*) as count,
          COALESCE(SUM(volume), 0) as total_volume,
          COALESCE(SUM(quantity), 0) as total_quantity
        FROM work_items
        WHERE started_at >= $1::timestamp
          AND started_at <= $2::timestamp
          AND status != 'VOID'
          ${siteFilter}
        GROUP BY ${dateExpr}
        ORDER BY period ASC`,
        ...queryParams,
      );

      return trends.map((t) => ({
        date: t.period,
        period: t.period,
        count: Number(t.count),
        volume: Number(t.total_volume),
        quantity: Number(t.total_quantity),
        totalVolume: Number(t.total_volume),
        totalQuantity: Number(t.total_quantity),
      }));
    } catch (err) {
      this.logger.warn('getTrends failed', err);
      return [];
    }
  }

  /**
   * CSV 내보내기
   * 지정 기간의 모든 작업 데이터를 CSV 문자열로 반환
   */
  async exportCsv(from: string, to: string, siteId?: string): Promise<string> {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    const items = await this.prisma.workItem.findMany({
      where: {
        startedAt: { gte: fromDate, lte: toDate },
        ...(siteId && { startedByWorker: { siteId } }),
      },
      include: {
        classification: { select: { code: true, displayName: true } },
        startedByWorker: { select: { name: true, employeeCode: true } },
        endedByWorker: { select: { name: true, employeeCode: true } },
        assignments: {
          include: { worker: { select: { name: true, employeeCode: true } } },
        },
      },
      orderBy: { startedAt: 'asc' },
    });

    // CSV 헤더 (한글)
    const headers = [
      '작업ID',
      '상태',
      '분류코드',
      '분류명',
      '시작작업자사번',
      '시작작업자명',
      '종료작업자사번',
      '종료작업자명',
      '물량',
      '수량',
      '시작시각',
      '종료시각',
      '작업시간(분)',
      '참여자',
      '비고',
    ];

    const rows = items.map((item) => {
      // 작업 시간 계산 (분)
      let durationMinutes = '';
      if (item.endedAt && item.startedAt) {
        const diff = (item.endedAt.getTime() - item.startedAt.getTime()) / 60000;
        durationMinutes = diff.toFixed(1);
      }

      // 참여자 목록
      const participants = item.assignments
        .map((a) => `${a.worker.name}(${a.worker.employeeCode})`)
        .join('; ');

      return [
        item.id,
        item.status,
        item.classification.code,
        item.classification.displayName,
        item.startedByWorker.employeeCode,
        item.startedByWorker.name,
        item.endedByWorker?.employeeCode || '',
        item.endedByWorker?.name || '',
        item.volume.toString(),
        item.quantity.toString(),
        item.startedAt.toISOString(),
        item.endedAt?.toISOString() || '',
        durationMinutes,
        participants,
        item.notes || '',
      ];
    });

    // BOM + CSV 생성 (Excel 한글 호환)
    const bom = '\uFEFF';
    const csvContent = [
      headers.join(','),
      ...rows.map((row) =>
        row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','),
      ),
    ].join('\n');

    return bom + csvContent;
  }

  /**
   * 전기 대비 증감 비교
   * 일별이면 전일, 주별이면 전주, 월별이면 전월 자동 판단
   */
  async getComparison(from: string, to: string, siteId?: string) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    const diffMs = toDate.getTime() - fromDate.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    // 이전 기간 자동 계산
    const prevFrom = new Date(fromDate);
    const prevTo = new Date(toDate);
    if (diffDays <= 1) {
      // 일별 → 전일
      prevFrom.setDate(prevFrom.getDate() - 1);
      prevTo.setDate(prevTo.getDate() - 1);
    } else if (diffDays <= 7) {
      // 주별 → 전주
      prevFrom.setDate(prevFrom.getDate() - 7);
      prevTo.setDate(prevTo.getDate() - 7);
    } else {
      // 월별 → 전월
      prevFrom.setMonth(prevFrom.getMonth() - 1);
      prevTo.setMonth(prevTo.getMonth() - 1);
    }

    const buildFilter = (f: Date, t: Date): Prisma.WorkItemWhereInput => ({
      startedAt: { gte: f, lte: t },
      status: 'ENDED',
      ...(siteId && { startedByWorker: { siteId } }),
    });

    const [current, previous] = await Promise.all([
      this.prisma.workItem.aggregate({
        where: buildFilter(fromDate, toDate),
        _count: true,
        _sum: { volume: true, quantity: true },
      }),
      this.prisma.workItem.aggregate({
        where: buildFilter(prevFrom, prevTo),
        _count: true,
        _sum: { volume: true, quantity: true },
      }),
    ]);

    const calcRate = (cur: number, prev: number): string => {
      if (prev === 0) return cur > 0 ? '+100.0%' : '0.0%';
      return (((cur - prev) / prev) * 100 > 0 ? '+' : '') +
        (((cur - prev) / prev) * 100).toFixed(1) + '%';
    };

    const curCount = current._count;
    const prevCount = previous._count;
    const curVolume = Number(current._sum.volume ?? 0);
    const prevVolume = Number(previous._sum.volume ?? 0);
    const curQuantity = current._sum.quantity ?? 0;
    const prevQuantity = previous._sum.quantity ?? 0;

    return {
      period: { current: { from, to }, previous: { from: prevFrom.toISOString().split('T')[0], to: prevTo.toISOString().split('T')[0] } },
      count: { current: curCount, previous: prevCount, changeRate: calcRate(curCount, prevCount) },
      volume: { current: curVolume, previous: prevVolume, changeRate: calcRate(curVolume, prevVolume) },
      quantity: { current: curQuantity, previous: prevQuantity, changeRate: calcRate(curQuantity, prevQuantity) },
    };
  }

  /**
   * 이상 작업 탐지 알림
   */
  async getAlerts(from: string, to: string, siteId?: string) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    const baseFilter: Prisma.WorkItemWhereInput = {
      startedAt: { gte: fromDate, lte: toDate },
      ...(siteId && { startedByWorker: { siteId } }),
    };

    const alerts: { type: string; severity: string; message: string; count: number }[] = [];

    // 1) 평균 대비 2배 이상 긴 작업
    try {
      const siteCondition = siteId
        ? Prisma.sql`AND wi.started_by_worker_id IN (SELECT id FROM workers WHERE site_id = ${siteId})`
        : Prisma.empty;

      const longItems = await this.prisma.$queryRaw<{ cnt: bigint }[]>`
        WITH avg_dur AS (
          SELECT AVG(EXTRACT(EPOCH FROM (ended_at - started_at))) as avg_sec
          FROM work_items wi
          WHERE status = 'ENDED'
            AND ended_at IS NOT NULL
            AND started_at >= ${fromDate}
            AND started_at <= ${toDate}
            ${siteCondition}
        )
        SELECT COUNT(*) as cnt
        FROM work_items wi, avg_dur
        WHERE wi.status = 'ENDED'
          AND wi.ended_at IS NOT NULL
          AND wi.started_at >= ${fromDate}
          AND wi.started_at <= ${toDate}
          ${siteCondition}
          AND EXTRACT(EPOCH FROM (wi.ended_at - wi.started_at)) > avg_dur.avg_sec * 2
      `;
      const longCount = Number(longItems[0]?.cnt ?? 0);
      if (longCount > 0) {
        alerts.push({
          type: 'LONG_DURATION',
          severity: 'WARNING',
          message: `평균 대비 2배 이상 소요된 작업이 ${longCount}건 있습니다`,
          count: longCount,
        });
      }
    } catch (err) {
      this.logger.warn('Long duration alert query failed', err);
    }

    // 2) 24시간 이상 미종료 작업
    const now = new Date();
    const threshold24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const stuckCount = await this.prisma.workItem.count({
      where: {
        ...baseFilter,
        status: 'ACTIVE',
        startedAt: { lte: threshold24h },
      },
    });
    if (stuckCount > 0) {
      alerts.push({
        type: 'STUCK_WORK',
        severity: 'CRITICAL',
        message: `24시간 이상 미종료 작업이 ${stuckCount}건 있습니다`,
        count: stuckCount,
      });
    }

    // 3) 당일 VOID 비율 > 10%
    const [totalToday, voidToday] = await Promise.all([
      this.prisma.workItem.count({ where: baseFilter }),
      this.prisma.workItem.count({ where: { ...baseFilter, status: 'VOID' } }),
    ]);
    if (totalToday > 0) {
      const voidRate = (voidToday / totalToday) * 100;
      if (voidRate > 10) {
        alerts.push({
          type: 'HIGH_VOID_RATE',
          severity: 'WARNING',
          message: `VOID 비율이 ${voidRate.toFixed(1)}%로 기준(10%)을 초과합니다`,
          count: voidToday,
        });
      }
    }

    return { period: { from, to }, alerts };
  }

  // ── 대시보드 목표 ──

  async getGoals(siteId: string) {
    return this.prisma.dashboardGoal.findMany({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createGoal(data: {
    siteId: string;
    periodType: string;
    targetCount?: number;
    targetVolume?: number;
    targetQuantity?: number;
  }) {
    return this.prisma.dashboardGoal.create({
      data: {
        siteId: data.siteId,
        periodType: data.periodType,
        targetCount: data.targetCount ?? 0,
        targetVolume: data.targetVolume ?? 0,
        targetQuantity: data.targetQuantity ?? 0,
      },
    });
  }
}
