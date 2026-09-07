import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { kstDateRange } from '../common/kst-date.util';
import {
  calcNetWorkMinutes,
  loadBreakConfigResolver,
  breakOverlapMs,
} from '../common/utils/net-work-minutes';

// ─────────────────────────────────────────────────────────────
// KST 헬퍼 (#36 / #37 / #50 공용)
// ─────────────────────────────────────────────────────────────

/** KST = UTC+9 */
const KST_OFFSET_MS = 9 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** 집계 API 최대 조회 기간(일) — generate_series / 일별 피벗 행 수 상한 */
const MAX_RANGE_DAYS = 366;
/**
 * 미종료(ended_at NULL) 작업의 종료 간주 상한(ms) — "now" 로 보되 시작 후 24h 를 넘지 않음.
 * 고착 ACTIVE 작업(예: 2026-06-25 시작 후 미종료 1건 실측)이 이후 모든 시간대에 +1 인원/수개월 순작업시간으로
 * 잡히는 것을 막는다. 24h 는 getAlerts 의 STUCK_WORK 기준과 동일.
 */
const OPEN_ITEM_CAP_MS = 24 * 60 * 60_000;

/**
 * Postgres naive timestamp(UTC 값 저장) → KST 로컬 timestamp 변환 SQL 조각
 *
 * ※ work_items.started_at 은 `timestamp without time zone`(UTC 값)이고 Neon 세션 TZ 는 GMT 이므로
 *    단일 `col AT TIME ZONE 'Asia/Seoul'` 은 naive 값을 "서울 시각"으로 오해석해 −9h(표시상 −18h)가 된다.
 *    (2026-09-07 실측: started_at 08:42Z → 단일 변환 '09-06 23:42', 2단 변환 '09-07 17:42' = 정답)
 *    신규 쿼리는 반드시 `(col AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul'` 2단 변환을 사용한다.
 */
const KST_STARTED_AT = Prisma.sql`((wi.started_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')`;

/** ms 타임스탬프의 KST 자정 (UTC ms) — net-work-minutes.kstDayStart 와 동일 */
function kstDayStartMs(ts: number): number {
  const kst = new Date(ts + KST_OFFSET_MS);
  return Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - KST_OFFSET_MS;
}

/** ms 타임스탬프 → KST 'YYYY-MM-DD' */
function kstDateKey(ts: number): string {
  return new Date(ts + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' from~to (포함) 사이의 날짜 문자열 목록 */
function enumerateDays(from: string, to: string): string[] {
  const start = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const end = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  const days: string[] = [];
  for (let t = start; t <= end && days.length <= MAX_RANGE_DAYS; t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/** 자정 기준 경과 분 → 'HH:mm' (24h 초과(익일 종료)는 24로 나눈 나머지) */
function minutesToHHmm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * 작업 1건의 "실제 작업 구간" 목록 = [start, end] − 중간마감(pauseHistory) 구간
 * — calcNetWorkMinutes 의 1~2단계와 동일 로직 (notes JSON { pauseHistory: [{pausedAt, resumedAt}] })
 *   여러 작업의 구간을 union 해야 하므로(동시작업 batchId 중복계상 방지) 분 단위 결과가 아닌 구간을 돌려준다.
 */
function activeSegmentsOf(
  start: number,
  end: number,
  notes: string | null | undefined,
  hasEnded: boolean,
): Array<[number, number]> {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  const pauses: Array<[number, number]> = [];
  if (notes) {
    try {
      const parsed = JSON.parse(notes);
      if (Array.isArray(parsed?.pauseHistory)) {
        for (const entry of parsed.pauseHistory) {
          const pAt = entry?.pausedAt ? new Date(entry.pausedAt).getTime() : 0;
          const rAt = entry?.resumedAt
            ? new Date(entry.resumedAt).getTime()
            : hasEnded
              ? end
              : Date.now();
          if (pAt > 0 && Number.isFinite(rAt) && rAt > pAt) {
            const p = Math.max(pAt, start);
            const r = Math.min(rAt, end);
            if (r > p) pauses.push([p, r]);
          }
        }
      }
    } catch {
      // notes 가 JSON 이 아니면 중간마감 없음으로 간주
    }
  }

  const merged = mergeIntervals(pauses);
  const segments: Array<[number, number]> = [];
  let cursor = start;
  for (const [p, r] of merged) {
    if (p > cursor) segments.push([cursor, p]);
    cursor = Math.max(cursor, r);
  }
  if (end > cursor) segments.push([cursor, end]);
  return segments;
}

/** 구간 목록 union (겹치거나 맞닿은 구간 병합) */
function mergeIntervals(list: Array<[number, number]>): Array<[number, number]> {
  const sorted = list
    .filter(([s, e]) => e > s)
    .map(([s, e]): [number, number] => [s, e])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) {
      last[1] = Math.max(last[1], iv[1]);
    } else {
      merged.push([iv[0], iv[1]]);
    }
  }
  return merged;
}

/** 물동량 셀 (건수/CBM/수량) — #37 응답 타입 (컨트롤러 반환 타입에 노출되므로 export) */
export interface VolumeCell {
  count: number;
  volume: number;
  quantity: number;
}

const zeroCell = (): VolumeCell => ({ count: 0, volume: 0, quantity: 0 });
const addCell = (target: VolumeCell, src: VolumeCell) => {
  target.count += src.count;
  target.volume = Math.round((target.volume + src.volume) * 100) / 100;
  target.quantity += src.quantity;
};

/** CSV 내보내기 선택 필터 (C2 계약: status / classificationId / workerId) */
export interface ExportCsvFilters {
  status?: string;
  classificationId?: string;
  workerId?: string;
}

/** 작업 상태 허용값 (QueryWorkItemsDto.status와 동일) */
const WORK_ITEM_STATUSES = ['ACTIVE', 'PAUSED', 'ENDED', 'VOID'] as const;

/**
 * CSV status 필터 정규화
 * - 대소문자 무시 (CLAUDE.md 함정 #21)
 * - 프론트 레거시 'in_progress' → 'ACTIVE' 호환
 * - 빈 값이면 undefined(필터 없음), 알 수 없는 값이면 400
 */
function normalizeWorkItemStatus(raw?: string): string | undefined {
  const value = raw?.trim().toUpperCase();
  if (!value) return undefined;
  const mapped = value === 'IN_PROGRESS' ? 'ACTIVE' : value;
  if (!(WORK_ITEM_STATUSES as readonly string[]).includes(mapped)) {
    throw new BadRequestException(
      `status는 ${WORK_ITEM_STATUSES.join(', ')} 중 하나여야 합니다`,
    );
  }
  return mapped;
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 기간 내 종료(ENDED) 작업의 순작업시간(분) 목록 조회 (#33 서버 집계 통일)
   * - 순작업시간 = 총 시간 − 중간마감 구간 − 휴게시간 겹침 (calcNetWorkMinutes)
   * - 휴게시간: 작업자 siteId 의 BreakConfig, 없으면 전역(siteId NULL) 폴백. NULL 작업자는 전역
   * - 행 수가 많을 수 있어 최소 컬럼만 select
   */
  private async fetchEndedNetMinutes(
    where: Prisma.WorkItemWhereInput,
    siteId?: string,
  ): Promise<{ workerId: string; netMinutes: number }[]> {
    const rows = await this.prisma.workItem.findMany({
      where: { ...where, status: 'ENDED', endedAt: { not: null } },
      select: {
        startedByWorkerId: true,
        startedAt: true,
        endedAt: true,
        notes: true,
        startedByWorker: { select: { siteId: true } },
      },
    });

    const breaks = await loadBreakConfigResolver(this.prisma, [
      siteId,
      ...rows.map((r) => r.startedByWorker?.siteId),
    ]);

    return rows.map((r) => ({
      workerId: r.startedByWorkerId,
      netMinutes: calcNetWorkMinutes(
        r.startedAt,
        r.endedAt,
        r.notes,
        breaks.forSite(r.startedByWorker?.siteId),
      ),
    }));
  }

  /**
   * KPI 통계 조회
   * 기간별 작업 건수, 총 물량, 평균 작업 시간, 작업자별 통계 등
   */
  async getStats(from: string, to: string, siteId?: string) {
    const { fromDate, toDate } = kstDateRange(from, to);

    const dateFilter: Prisma.WorkItemWhereInput = {
      startedAt: { gte: fromDate, lte: toDate },
      ...(siteId && { startedByWorker: { OR: [{ siteId }, { siteId: null }] } }),
    };

    // 전체 건수 (상태별) — groupBy 1회 쿼리로 집계
    const statusCounts = await this.prisma.workItem.groupBy({
      by: ['status'],
      where: dateFilter,
      _count: true,
    });
    const countMap = Object.fromEntries(statusCounts.map(s => [s.status, s._count]));
    const totalActive = countMap['ACTIVE'] || 0;
    const totalPaused = countMap['PAUSED'] || 0;
    const totalEnded = countMap['ENDED'] || 0;
    const totalVoid = countMap['VOID'] || 0;

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
      totalVolume: Number(c._sum.volume ?? 0),
      totalQuantity: Number(c._sum.quantity ?? 0),
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
      totalVolume: Number(w._sum.volume ?? 0),
      totalQuantity: Number(w._sum.quantity ?? 0),
    }));

    // 평균 순작업시간 (종료된 작업, 분 단위) — 행 fetch 후 JS calcNetWorkMinutes 집계 (#33)
    // 중간마감·휴게시간 차감 반영, 반올림 Math.round
    let avgDurationMinutes: number | null = null;
    try {
      const ended = await this.fetchEndedNetMinutes(dateFilter, siteId);
      avgDurationMinutes =
        ended.length > 0
          ? Math.round(ended.reduce((sum, e) => sum + e.netMinutes, 0) / ended.length)
          : null;
    } catch (err) {
      this.logger.error('평균 작업 시간 계산 실패', err instanceof Error ? err.stack : err);
    }

    return {
      period: { from, to },
      counts: {
        active: totalActive,
        paused: totalPaused,
        ended: totalEnded,
        void: totalVoid,
        // ★ PAUSED 포함 (이전엔 누락되어 위젯/대시보드 합계 어긋남 — CLAUDE.md 함정 #14)
        total: totalActive + totalPaused + totalEnded + totalVoid,
      },
      aggregates: {
        totalVolume: Number(aggregates._sum.volume ?? 0),
        totalQuantity: Number(aggregates._sum.quantity ?? 0),
        avgVolume: Number(aggregates._avg.volume ?? 0),
        avgQuantity: Number(aggregates._avg.quantity ?? 0),
        endedCount: aggregates._count,
      },
      avgDurationMinutes,
      byClassification: classificationStats,
      topWorkers: workerStats,
    };
  }

  /**
   * 작업자별 통계 (전용 엔드포인트)
   * 전체 작업자의 작업 건수, 물량, 수량을 반환
   */
  async getWorkerStats(siteId: string | undefined, from: string, to: string) {
    const { fromDate, toDate } = kstDateRange(from, to);

    const dateFilter: Prisma.WorkItemWhereInput = {
      startedAt: { gte: fromDate, lte: toDate },
      status: 'ENDED',
      ...(siteId && { startedByWorker: { OR: [{ siteId }, { siteId: null }] } }),
    };

    const byWorker = await this.prisma.workItem.groupBy({
      by: ['startedByWorkerId'],
      where: dateFilter,
      _count: true,
      _sum: { volume: true, quantity: true },
    });

    // 작업자별 평균 순작업시간 — 행 fetch 후 JS calcNetWorkMinutes 집계 (#33)
    // 중간마감·휴게시간 차감 반영, 반올림 Math.round
    const ended = await this.fetchEndedNetMinutes(dateFilter, siteId);
    const durationAgg = new Map<string, { sum: number; count: number }>();
    for (const e of ended) {
      const agg = durationAgg.get(e.workerId) ?? { sum: 0, count: 0 };
      agg.sum += e.netMinutes;
      agg.count += 1;
      durationAgg.set(e.workerId, agg);
    }
    const durationMap: Record<string, number | null> = {};
    durationAgg.forEach((agg, wid) => {
      durationMap[wid] = agg.count > 0 ? Math.round(agg.sum / agg.count) : null;
    });

    // 작업자 이름 조회
    const workerIds = byWorker.map(w => w.startedByWorkerId);
    const workers = await this.prisma.worker.findMany({
      where: { id: { in: workerIds } },
      select: { id: true, name: true, employeeCode: true },
    });
    const workerMap = Object.fromEntries(workers.map(w => [w.id, w]));

    const topWorkers = byWorker
      .map(w => ({
        workerId: w.startedByWorkerId,
        name: workerMap[w.startedByWorkerId]?.name || '-',
        employeeCode: workerMap[w.startedByWorkerId]?.employeeCode || '-',
        count: w._count,
        totalVolume: Number(w._sum.volume ?? 0),
        totalQuantity: Number(w._sum.quantity ?? 0),
        avgDuration: durationMap[w.startedByWorkerId] ?? null,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      totalWorkers: topWorkers.length,
      topWorkers,
    };
  }

  /**
   * 트렌드 데이터 (차트용)
   * 일별/주별/월별 그룹핑
   */
  async getTrends(from: string, to: string, groupBy: 'hour' | 'day' | 'week' | 'month' = 'day', siteId?: string) {
    const { fromDate, toDate } = kstDateRange(from, to);

    // P0-3: $queryRawUnsafe 제거 — Prisma.sql 태그드 템플릿으로 전환
    // dateExpr은 whitelist 분기지만 template literal로 문자열 치환하던 패턴을 parameterized로
    const dateExpr = (() => {
      switch (groupBy) {
        case 'hour':
          return Prisma.sql`to_char(started_at AT TIME ZONE 'Asia/Seoul', 'HH24')`;
        case 'week':
          return Prisma.sql`to_char(date_trunc('week', started_at AT TIME ZONE 'Asia/Seoul'), 'YYYY-"W"IW')`;
        case 'month':
          return Prisma.sql`to_char(date_trunc('month', started_at AT TIME ZONE 'Asia/Seoul'), 'YYYY-MM-DD')`;
        default:
          return Prisma.sql`to_char(started_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`;
      }
    })();

    const siteFilter = siteId
      ? Prisma.sql`AND started_by_worker_id IN (SELECT id FROM workers WHERE site_id = ${siteId} OR site_id IS NULL)`
      : Prisma.empty;

    try {
      const trends = await this.prisma.$queryRaw<
        { period: string; count: bigint; total_volume: number; total_quantity: bigint }[]
      >(Prisma.sql`
        SELECT
          ${dateExpr} as period,
          COUNT(*) as count,
          COALESCE(SUM(volume), 0) as total_volume,
          COALESCE(SUM(quantity), 0) as total_quantity
        FROM work_items
        WHERE started_at >= ${fromDate}
          AND started_at <= ${toDate}
          AND status != 'VOID'
          ${siteFilter}
        GROUP BY ${dateExpr}
        ORDER BY period ASC
      `);

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
      this.logger.error('getTrends 쿼리 실패', err instanceof Error ? err.stack : err);
      throw new InternalServerErrorException('트렌드 데이터 조회에 실패했습니다');
    }
  }

  /**
   * CSV 내보내기
   * 지정 기간의 모든 작업 데이터를 CSV 문자열로 반환
   *
   * @param filters 선택 필터 (C2 계약) — 작업기록 목록(findAllForAdmin)과 동일한 의미
   *   - status: ACTIVE|PAUSED|ENDED|VOID (대소문자 무시, 'IN_PROGRESS'→ACTIVE 호환)
   *   - classificationId: 분류 ID
   *   - workerId: 시작 작업자 또는 배정 참여자
   *   기존 호출 exportCsv(from, to, siteId) 는 filters 없이 그대로 동작 (하위호환)
   */
  async exportCsv(
    from: string,
    to: string,
    siteId?: string,
    filters?: ExportCsvFilters,
  ): Promise<string> {
    const { fromDate, toDate } = kstDateRange(from, to);

    const where: Prisma.WorkItemWhereInput = {
      startedAt: { gte: fromDate, lte: toDate },
      // ★ siteId 격리: 해당 사업장 작업자 + siteId 미배정(NULL) 작업자 포함 (기존 데이터 보호)
      ...(siteId && { startedByWorker: { OR: [{ siteId }, { siteId: null }] } }),
    };

    // 상태 필터 (목록 조회와 동일 값). 컨트롤러에 DTO 검증이 없으므로 여기서 정규화·검증
    const status = normalizeWorkItemStatus(filters?.status);
    if (status) {
      where.status = status;
    }

    // 분류 필터
    const classificationId = filters?.classificationId?.trim();
    if (classificationId) {
      where.classificationId = classificationId;
    }

    // 작업자 필터: 시작 작업자 또는 배정 참여자 (findAllForAdmin과 동일)
    const workerId = filters?.workerId?.trim();
    if (workerId) {
      where.OR = [
        { startedByWorkerId: workerId },
        { assignments: { some: { workerId } } },
      ];
    }

    const MAX_CSV_ROWS = 10000;
    const items = await this.prisma.workItem.findMany({
      where,
      include: {
        classification: { select: { code: true, displayName: true } },
        startedByWorker: { select: { name: true, employeeCode: true, siteId: true } },
        endedByWorker: { select: { name: true, employeeCode: true } },
        assignments: {
          include: { worker: { select: { name: true, employeeCode: true } } },
        },
      },
      orderBy: { startedAt: 'asc' },
      take: MAX_CSV_ROWS,
    });

    // 순작업시간 계산용 휴게시간 설정 (작업자 siteId 기준, NULL 작업자는 전역)
    const breaks = await loadBreakConfigResolver(this.prisma, [
      siteId,
      ...items.map((i) => i.startedByWorker?.siteId),
    ]);

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
      '순작업시간(분)',
      '참여자',
      '비고',
    ];

    const rows = items.map((item) => {
      // 작업 시간 계산 (분)
      let durationMinutes = '';
      // 순작업시간 (중간마감·휴게시간 차감, Math.round) — 종료된 작업만
      let netMinutes = '';
      if (item.endedAt && item.startedAt) {
        const diff = (item.endedAt.getTime() - item.startedAt.getTime()) / 60000;
        durationMinutes = diff.toFixed(1);
        netMinutes = String(
          calcNetWorkMinutes(
            item.startedAt,
            item.endedAt,
            item.notes,
            breaks.forSite(item.startedByWorker?.siteId),
          ),
        );
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
        netMinutes,
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
    const { fromDate, toDate } = kstDateRange(from, to);

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
      ...(siteId && { startedByWorker: { OR: [{ siteId }, { siteId: null }] } }),
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
    const { fromDate, toDate } = kstDateRange(from, to);

    const baseFilter: Prisma.WorkItemWhereInput = {
      startedAt: { gte: fromDate, lte: toDate },
      ...(siteId && { startedByWorker: { OR: [{ siteId }, { siteId: null }] } }),
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

  /** 집계 API 기간 상한 검사 (generate_series / 일별 피벗 폭주 방지) */
  private assertRangeDays(fromDate: Date, toDate: Date) {
    const days = Math.ceil((toDate.getTime() - fromDate.getTime()) / DAY_MS);
    if (days > MAX_RANGE_DAYS) {
      throw new BadRequestException(`조회 기간은 최대 ${MAX_RANGE_DAYS}일까지 가능합니다`);
    }
  }

  /**
   * #36 작업자별 작업시간 요약 (월간)
   *
   * - 대상: 기간 내 시작한 VOID 제외 작업. 시작자 + WorkAssignment 참여자 모두 "참여"로 계상
   *   (incentives.service 근무일 SQL 과 동일한 UNION 규칙을 JS 로 수행)
   * - workDays: 참여 작업의 KST 시작일 distinct
   * - firstStartAvg / lastEndAvg: 일별 첫 시작·마지막 종료(미종료는 now)의 자정 기준 경과분 평균 → 'HH:mm'
   * - netMinutes: 각 작업의 실제 작업 구간(중간마감 제외)을 작업자별로 union 한 뒤 휴게시간 겹침 차감
   *   → 동시작업(batchId, 겹치는 구간)이 두 번 계상되지 않음. 휴게 차감은 calcNetWorkMinutes 와 동일한
   *   breakOverlapMs + loadBreakConfigResolver(작업자 siteId, NULL 은 전역) 사용, 반올림은 합계 후 1회
   * - itemCount: 참여 작업 건수 (distinct)
   * - 순위/비교 없음 — 이름순 정렬, 사실만 반환. MASTER 계정은 제외
   */
  async getWorkerTimeSummary(from: string, to: string, siteId?: string) {
    const { fromDate, toDate } = kstDateRange(from, to);
    this.assertRangeDays(fromDate, toDate);

    const items = await this.prisma.workItem.findMany({
      where: {
        startedAt: { gte: fromDate, lte: toDate },
        status: { not: 'VOID' },
        ...(siteId && { startedByWorker: { OR: [{ siteId }, { siteId: null }] } }),
      },
      select: {
        id: true,
        startedByWorkerId: true,
        startedAt: true,
        endedAt: true,
        notes: true,
        assignments: { select: { workerId: true } },
      },
    });
    if (items.length === 0) return [];

    const now = Date.now();
    type Acc = {
      itemIds: Set<string>;
      days: Map<string, { first: number; last: number }>;
      segments: Array<[number, number]>;
    };
    const acc = new Map<string, Acc>();

    for (const it of items) {
      const start = it.startedAt.getTime();
      // 미종료는 now, 단 시작 후 24h 상한 (고착 작업 보호 — OPEN_ITEM_CAP_MS)
      const end = it.endedAt ? it.endedAt.getTime() : Math.min(now, start + OPEN_ITEM_CAP_MS);
      if (!Number.isFinite(start)) continue;
      const dayKey = kstDateKey(start);
      const segs = activeSegmentsOf(start, end, it.notes, !!it.endedAt);
      const participants = new Set<string>([
        it.startedByWorkerId,
        ...it.assignments.map((a) => a.workerId),
      ]);
      for (const wid of participants) {
        let a = acc.get(wid);
        if (!a) {
          a = { itemIds: new Set(), days: new Map(), segments: [] };
          acc.set(wid, a);
        }
        a.itemIds.add(it.id);
        const d = a.days.get(dayKey);
        if (!d) {
          a.days.set(dayKey, { first: start, last: Math.max(start, end) });
        } else {
          d.first = Math.min(d.first, start);
          d.last = Math.max(d.last, end);
        }
        for (const [s, e] of segs) a.segments.push([s, e]);
      }
    }

    // 작업자 정보 배치 조회 (N+1 금지). MASTER 는 관리 목록에서 제외
    const workers = await this.prisma.worker.findMany({
      where: { id: { in: Array.from(acc.keys()) }, role: { not: 'MASTER' } },
      select: { id: true, name: true, employeeCode: true, siteId: true },
    });

    // 휴게시간 설정: 작업자 siteId 기준 (NULL 작업자는 전역) — 1회 조회
    const breaks = await loadBreakConfigResolver(this.prisma, [
      siteId,
      ...workers.map((w) => w.siteId),
    ]);

    return workers
      .map((w) => {
        const a = acc.get(w.id)!;
        const cfg = breaks.forSite(w.siteId);
        let netMs = 0;
        for (const [s, e] of mergeIntervals(a.segments)) {
          netMs += e - s - breakOverlapMs(s, e, cfg);
        }

        let firstSum = 0;
        let lastSum = 0;
        for (const d of a.days.values()) {
          const base = kstDayStartMs(d.first);
          firstSum += (d.first - base) / 60_000;
          lastSum += (d.last - base) / 60_000;
        }
        const workDays = a.days.size;

        return {
          workerId: w.id,
          name: w.name,
          employeeCode: w.employeeCode,
          workDays,
          firstStartAvg: workDays > 0 ? minutesToHHmm(firstSum / workDays) : null,
          lastEndAvg: workDays > 0 ? minutesToHHmm(lastSum / workDays) : null,
          netMinutes: Math.max(0, Math.round(netMs / 60_000)),
          itemCount: a.itemIds.size,
        };
      })
      .sort((x, y) => x.name.localeCompare(y.name, 'ko'));
  }

  /**
   * #37 거래처(분류)별 일별 물동량 명세 (피벗용)
   *
   * - getTrends 와 같은 raw SQL 이지만 GROUP BY KST 일자 × classification_id
   * - VOID 제외, 시작일 기준. siteId 격리는 getTrends 와 동일(작업자 siteId OR NULL)
   * - days: from~to 전체 날짜(데이터 없는 날 포함), rows: 날짜당 1행 (cells 는 데이터 있는 분류만)
   * - totals: 분류별 합계 + all(전체)
   */
  async getTrendsByClassification(
    from: string,
    to: string,
    siteId?: string,
    classificationId?: string,
  ) {
    const { fromDate, toDate } = kstDateRange(from, to);
    this.assertRangeDays(fromDate, toDate);

    const cid = classificationId?.trim() || undefined;
    if (cid) {
      // 대상 분류가 요청 사업장(또는 전역) 소속인지 검증 — 다른 사업장 분류 ID 로 우회 조회 차단
      const cls = await this.prisma.classification.findFirst({
        where: { id: cid, ...(siteId && { OR: [{ siteId }, { siteId: null }] }) },
        select: { id: true },
      });
      if (!cls) throw new NotFoundException('분류를 찾을 수 없습니다');
    }

    const siteFilter = siteId
      ? Prisma.sql`AND wi.started_by_worker_id IN (SELECT id FROM workers WHERE site_id = ${siteId} OR site_id IS NULL)`
      : Prisma.empty;
    const classFilter = cid ? Prisma.sql`AND wi.classification_id = ${cid}` : Prisma.empty;

    let raw: { day: string; classification_id: string; count: number; total_volume: number; total_quantity: bigint }[];
    try {
      raw = await this.prisma.$queryRaw<
        { day: string; classification_id: string; count: number; total_volume: number; total_quantity: bigint }[]
      >(Prisma.sql`
        SELECT
          to_char(${KST_STARTED_AT}, 'YYYY-MM-DD') AS day,
          wi.classification_id,
          COUNT(*)::int AS count,
          COALESCE(SUM(wi.volume), 0)::float AS total_volume,
          COALESCE(SUM(wi.quantity), 0)::bigint AS total_quantity
        FROM work_items wi
        WHERE wi.started_at >= ${fromDate}
          AND wi.started_at <= ${toDate}
          AND wi.status != 'VOID'
          ${siteFilter}
          ${classFilter}
        GROUP BY 1, 2
        ORDER BY 1, 2
      `);
    } catch (err) {
      this.logger.error('getTrendsByClassification 쿼리 실패', err instanceof Error ? err.stack : err);
      throw new InternalServerErrorException('거래처별 물동량 조회에 실패했습니다');
    }

    const days = enumerateDays(from, to);

    // 분류 이름 매핑 (배치 조회, sortOrder → code 순)
    const ids = Array.from(new Set(raw.map((r) => r.classification_id)));
    const classifications = ids.length
      ? await this.prisma.classification.findMany({
          where: { id: { in: ids } },
          select: { id: true, code: true, displayName: true },
          orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        })
      : [];
    const columns = classifications.map((c) => ({ id: c.id, code: c.code, displayName: c.displayName }));

    const byDay = new Map<string, Record<string, VolumeCell>>();
    const totals: Record<string, VolumeCell> = {};
    const all = zeroCell();
    for (const r of raw) {
      const cell: VolumeCell = {
        count: Number(r.count) || 0,
        volume: Math.round((Number(r.total_volume) || 0) * 100) / 100,
        quantity: Number(r.total_quantity) || 0,
      };
      const dayCells = byDay.get(r.day) ?? {};
      dayCells[r.classification_id] = cell;
      byDay.set(r.day, dayCells);
      const t = totals[r.classification_id] ?? (totals[r.classification_id] = zeroCell());
      addCell(t, cell);
      addCell(all, cell);
    }

    const rows = days.map((date) => {
      const cells = byDay.get(date) ?? {};
      const total = zeroCell();
      for (const c of Object.values(cells)) addCell(total, c);
      return { date, cells, total };
    });

    return {
      period: { from, to },
      days,
      columns,
      rows,
      totals: { ...totals, all },
    };
  }

  /**
   * #50 시간대별 부하 프로필 (요일 × 시각 평균 동시작업 인원)
   *
   * - generate_series 로 기간 내 KST 1시간 슬롯을 만들고, 각 슬롯과 겹치는 작업의 참여자
   *   (시작자 + WorkAssignment 참여자, UNION → distinct) 수를 센 뒤 요일·시각별 평균 (raw SQL 1개)
   * - VOID 제외, ended_at NULL(진행 중)은 now 로 간주(단 시작 후 24h 상한 — 고착 작업이 모든 슬롯에 +1 되는 것 방지),
   *   기간 밖에서 시작해 걸치는 작업도 포함
   * - 슬롯 경계: fromDate 가 KST 자정이므로 1시간 step 으로 KST 정시 경계에 정렬됨
   * - grid[dow][hour]: dow 0=일요일 … 6=토요일, 데이터 없는 슬롯은 0 (평균 분모에 포함)
   * - workStartHour/workEndHour: 활동이 있는 시각 범위 ±1h (없으면 06~20), [start, end) 반열림
   */
  async getLoadProfile(from: string, to: string, siteId?: string) {
    const { fromDate, toDate } = kstDateRange(from, to);
    this.assertRangeDays(fromDate, toDate);

    const siteFilter = siteId
      ? Prisma.sql`AND wi.started_by_worker_id IN (SELECT id FROM workers WHERE site_id = ${siteId} OR site_id IS NULL)`
      : Prisma.empty;

    let raw: { dow: number; hour: number; avg_cnt: number }[];
    try {
      raw = await this.prisma.$queryRaw<{ dow: number; hour: number; avg_cnt: number }[]>(Prisma.sql`
        WITH slots AS (
          SELECT gs AS slot_start, gs + interval '1 hour' AS slot_end
          FROM generate_series(${fromDate}::timestamp, ${toDate}::timestamp, interval '1 hour') AS gs
        ),
        parts AS (
          SELECT wi.started_by_worker_id AS worker_id,
                 wi.started_at,
                 COALESCE(wi.ended_at, LEAST((now() AT TIME ZONE 'UTC'), wi.started_at + interval '24 hours')) AS ended_at
          FROM work_items wi
          WHERE wi.status != 'VOID'
            AND wi.started_at <= ${toDate}
            AND COALESCE(wi.ended_at, LEAST((now() AT TIME ZONE 'UTC'), wi.started_at + interval '24 hours')) >= ${fromDate}
            ${siteFilter}
          UNION
          SELECT wa.worker_id,
                 wi.started_at,
                 COALESCE(wi.ended_at, LEAST((now() AT TIME ZONE 'UTC'), wi.started_at + interval '24 hours')) AS ended_at
          FROM work_items wi
          JOIN work_assignments wa ON wa.work_item_id = wi.id
          WHERE wi.status != 'VOID'
            AND wi.started_at <= ${toDate}
            AND COALESCE(wi.ended_at, LEAST((now() AT TIME ZONE 'UTC'), wi.started_at + interval '24 hours')) >= ${fromDate}
            ${siteFilter}
        ),
        slot_counts AS (
          SELECT s.slot_start, COUNT(DISTINCT p.worker_id) AS cnt
          FROM slots s
          LEFT JOIN parts p
            ON p.started_at < s.slot_end
           AND p.ended_at > s.slot_start
          GROUP BY s.slot_start
        )
        SELECT
          EXTRACT(DOW FROM ((slot_start AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul'))::int AS dow,
          EXTRACT(HOUR FROM ((slot_start AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul'))::int AS hour,
          AVG(cnt)::float AS avg_cnt
        FROM slot_counts
        GROUP BY 1, 2
        ORDER BY 1, 2
      `);
    } catch (err) {
      this.logger.error('getLoadProfile 쿼리 실패', err instanceof Error ? err.stack : err);
      throw new InternalServerErrorException('시간대별 부하 프로필 조회에 실패했습니다');
    }

    const grid: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const r of raw) {
      const d = Number(r.dow);
      const h = Number(r.hour);
      if (d >= 0 && d < 7 && h >= 0 && h < 24) {
        grid[d][h] = Math.round((Number(r.avg_cnt) || 0) * 100) / 100;
      }
    }

    // 운영시간 추정: "의미 있는 부하"(최대값의 10%, 최소 0.25명)가 있는 시각 범위 ±1h
    // — 야간 1회성 작업(평균 0.25명 미만)으로 그리드가 24열로 늘어나지 않도록 함. 없으면 06~20
    const maxLoad = Math.max(0, ...grid.flat());
    const threshold = Math.max(0.25, maxLoad * 0.1);
    let firstActive = -1;
    let lastActive = -1;
    for (let h = 0; h < 24; h++) {
      if (grid.some((row) => row[h] >= threshold)) {
        if (firstActive < 0) firstActive = h;
        lastActive = h;
      }
    }
    const workStartHour = firstActive < 0 ? 6 : Math.max(0, firstActive - 1);
    const workEndHour = lastActive < 0 ? 20 : Math.min(24, lastActive + 2);

    return { period: { from, to }, grid, workStartHour, workEndHour };
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
