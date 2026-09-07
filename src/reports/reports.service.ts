import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { kstDateRange } from '../common/kst-date.util';
import { resolveBillingSiteId } from '../common/utils/billing-site';

/** 보고서 기능 코드 — ReportsController @Feature('REPORTS') 와 동일 (서비스 레벨 재검사용) */
const REPORTS_FEATURE = 'REPORTS';

/** 요약 메일 상위 표시 개수 (분류 / 작업자) */
const SUMMARY_TOP_N = 5;

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
    const { report } = await this.collectReport(siteId, from, to, type, {
      includeTrends: true,
      includeAi,
    });
    return report;
  }

  // ══════════════════════════════════════════════
  // #32 일일/주간 요약 메일 (발송은 크론 evening-notices / weekly-summary 가 담당)
  // ══════════════════════════════════════════════

  /**
   * 센터 1곳의 일일(오늘 KST) / 주간(지난 7일: 어제까지) 작업 요약 메일 본문.
   * - 구독이 ACTIVE/TRIAL 이 아니거나 plan.features 에 'REPORTS' 가 없으면 null
   *   (EntitlementGuard 는 컨트롤러 전용 → 크론 경로 우회 방지를 위해 서비스 레벨 재검사)
   * - 활동 0(작업 0건 + 체감온도 기록 0건 + 자가체크 알림 0건)이면 null (휴무로 간주)
   * - 기존 generateSummary 로직(collectReport) 재사용, trends 는 제외(경량)
   * - TenantSettings.notifications.summaryDaily/summaryWeekly 수신 여부는 호출자(크론)가 판단
   */
  async buildSummaryMail(
    siteId: string,
    type: 'daily' | 'weekly',
  ): Promise<{ subject: string; html: string } | null> {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true, name: true, code: true, isActive: true },
    });
    if (!site || !site.isActive) {
      this.logger.warn(`[summary-mail] 비활성/미존재 센터 → 생략 (site ${siteId})`);
      return null;
    }

    if (!(await this.hasReportsEntitlement(siteId))) {
      this.logger.log(`[summary-mail] REPORTS 권한 없음 → 생략 (site ${siteId} ${site.name})`);
      return null;
    }

    const now = new Date();
    const DAY = 24 * 60 * 60 * 1000;
    const todayKey = this.kstDateKey(now);
    const period =
      type === 'daily'
        ? { from: todayKey, to: todayKey }
        : {
            from: this.kstDateKey(new Date(now.getTime() - 7 * DAY)),
            to: this.kstDateKey(new Date(now.getTime() - DAY)),
          };
    const { fromDate, toDate } = kstDateRange(period.from, period.to);

    // siteId NULL 폭염 데이터(레거시)는 첫 센터에만 귀속
    const includeNullSite = await this.isFirstActiveSite(siteId);
    const heatRecordScope: Prisma.HeatHourlyRecordWhereInput = includeNullSite
      ? { OR: [{ siteId }, { siteId: null }] }
      : { siteId };
    const heatAlertScope: Prisma.HeatCheckAlertWhereInput = includeNullSite
      ? { OR: [{ siteId }, { siteId: null }] }
      : { siteId };

    const [{ report, stats }, heatRecords, heatAlertCount] = await Promise.all([
      this.collectReport(siteId, period.from, period.to, type, { includeTrends: false }),
      this.prisma.heatHourlyRecord.aggregate({
        where: { ...heatRecordScope, recordedAt: { gte: fromDate, lte: toDate } },
        _count: true,
        _max: { wbgt: true },
      }),
      this.prisma.heatCheckAlert.count({
        where: { ...heatAlertScope, reportedAt: { gte: fromDate, lte: toDate } },
      }),
    ]);

    const heatRecordCount = Number(heatRecords._count ?? 0);
    const maxWbgt = heatRecords._max.wbgt != null ? Number(heatRecords._max.wbgt) : null;
    const totalCount = Number(report.kpiSummary.totalCount ?? 0);

    if (totalCount === 0 && heatRecordCount === 0 && heatAlertCount === 0) {
      this.logger.log(
        `[summary-mail] 활동 없음(휴무) → 생략 (site ${siteId} ${site.name}, ${type} ${period.from}~${period.to})`,
      );
      return null;
    }

    const unfinishedCount =
      Number(stats.counts.active ?? 0) + Number(stats.counts.paused ?? 0);

    const periodLabel =
      type === 'daily' ? period.from : `${period.from} ~ ${period.to}`;
    const subject =
      type === 'daily'
        ? `[새롬GLS][${site.name}] 일일 작업 요약 ${period.from}`
        : `[새롬GLS][${site.name}] 주간 작업 요약 ${period.from} ~ ${period.to}`;

    const html = this.renderSummaryMailHtml({
      type,
      siteName: site.name,
      siteCode: site.code,
      periodLabel,
      generatedAt: now,
      report,
      unfinishedCount,
      heatRecordCount,
      heatAlertCount,
      maxWbgt,
    });

    return { subject, html };
  }

  /**
   * 보고서 공통 수집 (generateSummary / buildSummaryMail 공용)
   * - includeTrends=false 면 getTrends 호출 생략 (trends: [])
   */
  private async collectReport(
    siteId: string | undefined,
    from: string,
    to: string,
    type: 'daily' | 'weekly' | 'monthly',
    options: { includeTrends: boolean; includeAi?: boolean },
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
      options.includeTrends
        ? this.dashboardService.getTrends(from, to, groupBy, siteId)
        : Promise.resolve([] as Awaited<ReturnType<DashboardService['getTrends']>>),
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
    if (options.includeAi) {
      aiSummary = this.buildSimpleAiSummary(stats, comparison, anomalies);
    }

    const report = {
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

    return { report, stats };
  }

  /**
   * 서비스 레벨 REPORTS 기능 권한 검사 — EntitlementGuard(컨트롤러) 와 동일 규칙:
   * 루트(청구) 사이트 최신 구독 → 없으면 FREE 플랜 features, 있으면 ACTIVE/TRIAL(대소문자 무시)
   * + TRIAL 만료 검사 + plan.features 포함 여부
   */
  private async hasReportsEntitlement(siteId: string): Promise<boolean> {
    const billingSiteId = await resolveBillingSiteId(this.prisma, siteId);
    const subscription = await this.prisma.subscription.findFirst({
      where: { siteId: billingSiteId },
      include: { plan: { select: { code: true, features: true } } },
      orderBy: { createdAt: 'desc' },
    });

    if (!subscription) {
      const freePlan = await this.prisma.plan.findUnique({
        where: { code: 'FREE' },
        select: { features: true },
      });
      return Boolean(freePlan?.features?.includes(REPORTS_FEATURE));
    }

    const status = String(subscription.status || '').toUpperCase();
    if (!['ACTIVE', 'TRIAL'].includes(status)) return false;
    if (
      status === 'TRIAL' &&
      subscription.trialEndsAt &&
      subscription.trialEndsAt < new Date()
    ) {
      return false;
    }
    return Boolean(subscription.plan?.features?.includes(REPORTS_FEATURE));
  }

  /** 가장 오래된 최상위 활성 센터인지 (siteId NULL 레거시 데이터 귀속 기준) */
  private async isFirstActiveSite(siteId: string): Promise<boolean> {
    const first = await this.prisma.site.findFirst({
      where: { parentSiteId: null, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return !first || first.id === siteId;
  }

  /** 요약 메일 본문 (간단한 인라인 스타일 HTML 표) */
  private renderSummaryMailHtml(input: {
    type: 'daily' | 'weekly';
    siteName: string;
    siteCode: string;
    periodLabel: string;
    generatedAt: Date;
    report: Awaited<ReturnType<ReportsService['collectReport']>>['report'];
    unfinishedCount: number;
    heatRecordCount: number;
    heatAlertCount: number;
    maxWbgt: number | null;
  }): string {
    const {
      type,
      siteName,
      siteCode,
      periodLabel,
      generatedAt,
      report,
      unfinishedCount,
      heatRecordCount,
      heatAlertCount,
      maxWbgt,
    } = input;
    const esc = (value: unknown) => this.escapeHtml(value);
    const num = (value: unknown, digits = 2) =>
      Number(value ?? 0).toLocaleString('ko-KR', { maximumFractionDigits: digits });
    const webBase = process.env.WEB_BASE_URL || 'https://sae-work.com';
    const cell =
      'padding:8px 12px;border:1px solid #E2E8F0;font-size:13px;color:#0F172A;vertical-align:top;';
    const cellRight = `${cell}text-align:right;white-space:nowrap;`;
    const head =
      'padding:8px 12px;border:1px solid #E2E8F0;font-size:12px;color:#475569;background:#F8FAFC;text-align:left;';
    const headRight = `${head}text-align:right;`;
    const sectionTitle = 'margin:18px 0 6px;font-size:14px;color:#0F172A;';

    const changeColor = (rate: string) =>
      rate.startsWith('+') ? '#047857' : rate.startsWith('-') ? '#B91C1C' : '#475569';
    const changeCell = (rate: string, previous: unknown, digits = 2) =>
      `<td style="${cellRight}"><span style="color:${changeColor(rate)};font-weight:600;">${esc(rate)}</span><br/><span style="color:#94A3B8;font-size:11px;">전기 ${num(previous, digits)}</span></td>`;

    const kpi = report.kpiSummary;
    const cmp = report.comparison;
    const periodWord = type === 'daily' ? '전일' : '전주';

    const kpiTable = `<table style="border-collapse:collapse;width:100%;">
      <thead><tr>
        <th style="${head}">지표</th><th style="${headRight}">이번 기간</th><th style="${headRight}">${periodWord} 대비</th>
      </tr></thead>
      <tbody>
        <tr><td style="${cell}">작업 건수 (전체)</td><td style="${cellRight}">${num(kpi.totalCount, 0)}건</td><td style="${cellRight}"><span style="color:#94A3B8;font-size:11px;">완료 ${num(kpi.endedCount, 0)} · 취소 ${num(kpi.voidCount, 0)}</span></td></tr>
        <tr><td style="${cell}">완료 건수 (ENDED)</td><td style="${cellRight}">${num(cmp.current.count, 0)}건</td>${changeCell(cmp.countChange, cmp.previous.count, 0)}</tr>
        <tr><td style="${cell}">총 CBM (완료 기준)</td><td style="${cellRight}">${num(kpi.totalVolume)}</td>${changeCell(cmp.volumeChange, cmp.previous.volume)}</tr>
        <tr><td style="${cell}">총 BOX (완료 기준)</td><td style="${cellRight}">${num(kpi.totalQuantity, 0)}</td>${changeCell(cmp.quantityChange, cmp.previous.quantity, 0)}</tr>
        <tr><td style="${cell}">평균 소요 시간</td><td style="${cellRight}">${kpi.avgDurationMinutes != null ? `${num(kpi.avgDurationMinutes, 1)}분` : '-'}</td><td style="${cellRight}"></td></tr>
        <tr><td style="${cell}">미종료 (진행+일시정지)</td><td style="${cellRight}"><span style="color:${unfinishedCount > 0 ? '#B45309' : '#0F172A'};font-weight:${unfinishedCount > 0 ? 600 : 400};">${num(unfinishedCount, 0)}건</span></td><td style="${cellRight}"><span style="color:#94A3B8;font-size:11px;">${unfinishedCount > 0 ? '종료 누락 확인 필요' : ''}</span></td></tr>
        <tr><td style="${cell}">참여 작업자</td><td style="${cellRight}">${num(report.workerCount, 0)}명</td><td style="${cellRight}"></td></tr>
      </tbody>
    </table>`;

    const topClassifications = [...(report.classificationPerformance || [])]
      .sort((a, b) => Number(b.count ?? 0) - Number(a.count ?? 0))
      .slice(0, SUMMARY_TOP_N);
    const classificationTable =
      topClassifications.length > 0
        ? `<table style="border-collapse:collapse;width:100%;">
      <thead><tr><th style="${head}">분류</th><th style="${headRight}">건수</th><th style="${headRight}">CBM</th><th style="${headRight}">BOX</th></tr></thead>
      <tbody>${topClassifications
        .map((item) => {
          const cls = item.classification as { displayName?: string; code?: string; id?: string };
          const label = cls.displayName || cls.code || cls.id || '-';
          return `<tr><td style="${cell}">${esc(label)}</td><td style="${cellRight}">${num(item.count, 0)}</td><td style="${cellRight}">${num(item.totalVolume)}</td><td style="${cellRight}">${num(item.totalQuantity, 0)}</td></tr>`;
        })
        .join('')}</tbody>
    </table>`
        : `<p style="margin:0;font-size:13px;color:#94A3B8;">분류별 실적 없음</p>`;

    const topWorkers = (report.topWorkers || []).slice(0, SUMMARY_TOP_N);
    const workerTable =
      topWorkers.length > 0
        ? `<table style="border-collapse:collapse;width:100%;">
      <thead><tr><th style="${head}">작업자</th><th style="${headRight}">건수</th><th style="${headRight}">CBM</th><th style="${headRight}">BOX</th><th style="${headRight}">평균 소요</th></tr></thead>
      <tbody>${topWorkers
        .map(
          (item, index) =>
            `<tr><td style="${cell}"><span style="color:#94A3B8;font-size:11px;">${index + 1}.</span> ${esc(item.worker.name)} <span style="color:#94A3B8;font-size:11px;">(${esc(item.worker.employeeCode)})</span></td><td style="${cellRight}">${num(item.count, 0)}</td><td style="${cellRight}">${num(item.totalVolume)}</td><td style="${cellRight}">${num(item.totalQuantity, 0)}</td><td style="${cellRight}">${item.avgDuration != null ? `${num(item.avgDuration, 1)}분` : '-'}</td></tr>`,
        )
        .join('')}</tbody>
    </table>`
        : `<p style="margin:0;font-size:13px;color:#94A3B8;">완료 작업자 없음</p>`;

    const heatTable = `<table style="border-collapse:collapse;width:100%;">
      <tbody>
        <tr><td style="${cell}">폭염 자가체크 알림</td><td style="${cellRight}"><span style="color:${heatAlertCount > 0 ? '#B91C1C' : '#0F172A'};font-weight:${heatAlertCount > 0 ? 600 : 400};">${num(heatAlertCount, 0)}건</span></td></tr>
        <tr><td style="${cell}">체감온도 기록 (시간별)</td><td style="${cellRight}">${num(heatRecordCount, 0)}건${maxWbgt != null ? ` · 최고 체감온도 ${num(maxWbgt, 1)}℃` : ''}</td></tr>
      </tbody>
    </table>`;

    const anomalies = report.anomalies || [];
    const anomalySection =
      anomalies.length > 0
        ? `<ul style="margin:0;padding-left:18px;font-size:13px;color:#0F172A;">${anomalies
            .map(
              (item) =>
                `<li style="margin:2px 0;"><span style="color:${item.severity === 'CRITICAL' ? '#B91C1C' : '#B45309'};font-weight:600;">[${esc(item.severity)}]</span> ${esc(item.message)}</li>`,
            )
            .join('')}</ul>`
        : `<p style="margin:0;font-size:13px;color:#047857;">특이사항 없음</p>`;

    const title = type === 'daily' ? '일일 작업 요약' : '주간 작업 요약';
    const periodDesc = type === 'daily' ? '오늘 (KST)' : '지난 7일 (KST)';

    return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;max-width:760px;margin:0 auto;color:#0F172A;">
  <h2 style="margin:0 0 4px;font-size:18px;">${esc(siteName)} ${title}</h2>
  <p style="margin:0 0 12px;font-size:13px;color:#475569;">기간 ${esc(periodLabel)} · ${periodDesc} · 센터 코드 ${esc(siteCode)} · 생성 ${esc(this.kstDateTime(generatedAt))}</p>
  <h3 style="${sectionTitle}">실적 요약</h3>
  ${kpiTable}
  <h3 style="${sectionTitle}">분류별 상위 ${SUMMARY_TOP_N}</h3>
  ${classificationTable}
  <h3 style="${sectionTitle}">작업자 TOP ${SUMMARY_TOP_N} (완료 건수 기준)</h3>
  ${workerTable}
  <h3 style="${sectionTitle}">폭염 관리</h3>
  ${heatTable}
  <h3 style="${sectionTitle}">특이사항</h3>
  ${anomalySection}
  <p style="margin:18px 0 0;font-size:12px;color:#94A3B8;">
    CBM/BOX 는 완료(ENDED) 작업 기준 · 전기 대비는 ${periodWord} 동일 기간 · 상세 보고서: <a href="${esc(webBase)}/reports" style="color:#2C6FB0;">${esc(webBase)}/reports</a><br/>
    새롬GLS 작업현황 공유 시스템 자동 발송 — 수신 설정은 웹 설정(알림 수신자)에서 변경할 수 있습니다.
  </p>
</div>`;
  }

  /** KST 날짜 키 'YYYY-MM-DD' */
  private kstDateKey(date: Date): string {
    return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  /** KST 'YYYY-MM-DD HH:mm' */
  private kstDateTime(date: Date): string {
    const iso = new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }

  /** 메일 본문 HTML 이스케이프 (센터명/작업자명 등 사용자 입력값) */
  private escapeHtml(value: unknown): string {
    const map: Record<string, string> = {
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      '"': '&quot;',
    };
    return String(value ?? '').replace(/[<>&"]/g, (c) => map[c] ?? c);
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
