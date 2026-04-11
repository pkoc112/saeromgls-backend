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
}
