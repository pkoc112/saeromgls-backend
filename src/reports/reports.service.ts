import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardService } from '../dashboard/dashboard.service';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dashboardService: DashboardService,
  ) {}

  /**
   * 보고서 데이터 생성
   * 기존 dashboard 서비스의 getStats/getTrends를 재사용하여 보고서 구조로 조합
   */
  async generateSummary(
    siteId: string | undefined,
    from: string,
    to: string,
    type: 'daily' | 'weekly' | 'monthly',
    includeAi = false,
  ) {
    // 1) 기본정보
    const groupBy: 'hour' | 'day' | 'week' =
      type === 'daily' ? 'hour' : type === 'weekly' ? 'day' : 'week';
    const reportInfo = {
      type,
      period: { from, to },
      generatedAt: new Date().toISOString(),
      siteId: siteId || 'ALL',
      // 프론트가 추이 구간 라벨(시간대/일자/주차)을 결정할 때 사용
      groupBy,
    };

    // 2) KPI 요약, 트렌드, 전기 대비 증감, 알림, 작업자 전원 — 병렬 조회
    const [stats, trends, comparison, alertsData, workerStatsData] = await Promise.all([
      this.dashboardService.getStats(from, to, siteId),
      this.dashboardService.getTrends(from, to, groupBy, siteId),
      this.dashboardService.getComparison(from, to, siteId),
      this.dashboardService.getAlerts(from, to, siteId),
      // getStats.topWorkers는 take:10 캡이 있으므로 캡 없는 getWorkerStats를 별도 호출
      this.dashboardService.getWorkerStats(siteId, from, to),
    ]);

    // 5) 분류별 실적 (stats에서 추출)
    const classificationPerformance = stats.byClassification;

    // 6) 작업자 전원 (캡 없음, ENDED 기준 — KPI 총 CBM/BOX와 동일 기준)
    //    프론트 기존 shape { worker: { id, name, employeeCode }, count, totalVolume, totalQuantity } 유지 + avgDuration 추가
    const topWorkers = (workerStatsData.topWorkers || []).map((w) => ({
      worker: { id: w.workerId, name: w.name, employeeCode: w.employeeCode },
      count: Number(w.count ?? 0),
      totalVolume: Number(w.totalVolume ?? 0),
      totalQuantity: Number(w.totalQuantity ?? 0),
      avgDuration:
        w.avgDuration != null && !Number.isNaN(Number(w.avgDuration))
          ? Math.round(Number(w.avgDuration) * 100) / 100
          : null,
    }));
    const workerCount = Number(workerStatsData.totalWorkers ?? topWorkers.length);

    // 7) 특이사항 — 알림 기반
    const anomalies = alertsData.alerts || [];

    // 8) AI 요약 (선택적)
    let aiSummary: string | null = null;
    if (includeAi) {
      aiSummary = this.buildSimpleAiSummary(stats, comparison, anomalies);
    }

    return {
      reportInfo,
      kpiSummary: {
        totalCount: stats.counts.total,
        endedCount: stats.counts.ended,
        activeCount: stats.counts.active,
        voidCount: stats.counts.void,
        totalVolume: stats.aggregates.totalVolume,
        totalQuantity: stats.aggregates.totalQuantity,
        avgDurationMinutes: stats.avgDurationMinutes,
      },
      comparison: {
        // changeRate는 '+12.3%' / '-4.0%' / '0.0%' 형식 문자열 (dashboard.service.calcRate)
        countChange: comparison.count.changeRate,
        volumeChange: comparison.volume.changeRate,
        quantityChange: comparison.quantity.changeRate,
        previousPeriod: comparison.period.previous,
        current: {
          count: Number(comparison.count.current ?? 0),
          volume: Number(comparison.volume.current ?? 0),
          quantity: Number(comparison.quantity.current ?? 0),
        },
        previous: {
          count: Number(comparison.count.previous ?? 0),
          volume: Number(comparison.volume.previous ?? 0),
          quantity: Number(comparison.quantity.previous ?? 0),
        },
      },
      classificationPerformance,
      topWorkers,
      workerCount,
      trends,
      anomalies,
      aiSummary,
    };
  }

  /**
   * 간단한 AI 요약 텍스트 생성 (외부 API 없이 규칙 기반)
   */
  private buildSimpleAiSummary(
    stats: any,
    comparison: any,
    anomalies: any[],
  ): string {
    const lines: string[] = [];

    // 실적 요약
    lines.push(
      `기간 내 총 ${stats.counts.total}건의 작업이 등록되었으며, ` +
      `${stats.counts.ended}건이 완료되었습니다.`,
    );

    // 전기 대비
    lines.push(
      `전기 대비 작업 건수는 ${comparison.count.changeRate}, ` +
      `물량은 ${comparison.volume.changeRate} 변동되었습니다.`,
    );

    // 특이사항
    if (anomalies.length > 0) {
      lines.push(`특이사항: ${anomalies.map((a: any) => a.message).join('; ')}`);
    } else {
      lines.push('특이사항 없음.');
    }

    return lines.join(' ');
  }
}
