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
    const reportInfo = {
      type,
      period: { from, to },
      generatedAt: new Date().toISOString(),
      siteId: siteId || 'ALL',
    };

    // 2) KPI 요약, 트렌드, 전기 대비 증감, 알림 — 병렬 조회
    const groupBy = type === 'daily' ? 'hour' : type === 'weekly' ? 'day' : 'week';
    const [stats, trends, comparison, alertsData] = await Promise.all([
      this.dashboardService.getStats(from, to, siteId),
      this.dashboardService.getTrends(from, to, groupBy, siteId),
      this.dashboardService.getComparison(from, to, siteId),
      this.dashboardService.getAlerts(from, to, siteId),
    ]);

    // 5) 분류별 실적 (stats에서 추출)
    const classificationPerformance = stats.byClassification;

    // 6) 작업자 TOP 5
    const topWorkers = (stats.topWorkers || []).slice(0, 5);

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
        countChange: comparison.count.changeRate,
        volumeChange: comparison.volume.changeRate,
        quantityChange: comparison.quantity.changeRate,
        previousPeriod: comparison.period.previous,
      },
      classificationPerformance,
      topWorkers,
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
