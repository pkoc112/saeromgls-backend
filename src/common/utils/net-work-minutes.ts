import type { PrismaClient } from '@prisma/client';

/**
 * 순작업시간(분) 계산 유틸 — 서버 집계 통일 (#33)
 *
 * 순작업시간 = (startedAt ~ endedAt|now) 총 시간
 *   - 중간마감(PAUSED) 구간 (notes JSON { pauseHistory: [{pausedAt, resumedAt}] })
 *   - 휴게시간 구간 (BreakConfig, KST 기준 매일 반복) 과 "실제 작업 구간"의 겹침
 *
 * KST 자정을 기준으로 하루씩 순회하며 겹친 휴게 구간은 병합한다.
 *
 * ※ 휴게 겹침은 중간마감을 제외한 "실제 작업 구간"에 대해서만 계산하므로
 *   휴게시간 중 중간마감 상태였던 구간이 이중 차감되지 않는다.
 */

/** 휴게시간 설정 최소 형태 (BreakConfig 모델의 시간 필드) */
export interface BreakConfigLike {
  startHour: number;
  startMin: number;
  endHour: number;
  endMin: number;
}

/** KST = UTC+9 */
const KST_OFFSET_MS = 9 * 60 * 60_000;
const DAY_MS = 24 * 3_600_000;

/** 겹치거나 맞닿은 구간의 합집합. 입력 배열은 변경하지 않는다. */
export function mergeIntervals(list: Array<[number, number]>): Array<[number, number]> {
  const sorted = list
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .map(([s, e]): [number, number] => [s, e])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push(interval);
  }
  return merged;
}

/**
 * KST 자정(UTC 기준 ms)을 반환 — 서버 타임존에 무관하게 항상 KST 기준
 */
function kstDayStart(timestamp: number): number {
  const kstDate = new Date(timestamp + KST_OFFSET_MS);
  return (
    Date.UTC(kstDate.getUTCFullYear(), kstDate.getUTCMonth(), kstDate.getUTCDate()) -
    KST_OFFSET_MS
  );
}

/**
 * [rangeStart, rangeEnd] 구간과 휴게시간(KST, 매일 반복)의 겹침 총 밀리초
 * — 모바일 breakOverlapMs 와 동일 로직
 */
export function breakOverlapMs(
  rangeStart: number,
  rangeEnd: number,
  breakConfigs: readonly BreakConfigLike[] | undefined,
): number {
  if (!breakConfigs || breakConfigs.length === 0) return 0;
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) return 0;

  const periods = mergeIntervals(breakConfigs.map((b) => [
    (Number(b.startHour) * 60 + Number(b.startMin)) * 60_000,
    (Number(b.endHour) * 60 + Number(b.endMin)) * 60_000,
  ]).filter(([s, e]) => s >= 0 && e <= DAY_MS) as Array<[number, number]>);

  let total = 0;
  let dayBase = kstDayStart(rangeStart); // KST 자정 (UTC ms)

  while (dayBase < rangeEnd) {
    for (const [s, e] of periods) {
      const bStart = dayBase + s;
      const bEnd = dayBase + e;
      const os = Math.max(bStart, rangeStart);
      const oe = Math.min(bEnd, rangeEnd);
      if (oe > os) total += oe - os;
    }
    dayBase += DAY_MS;
  }

  return total;
}

/**
 * notes 의 pauseHistory 를 [pausedAt, resumedAt] ms 구간 목록으로 파싱
 * - resumedAt 없으면 (종료된 작업) endedAt / (진행 중) now 까지 정지로 간주 — 기존 로직 유지
 * - notes 가 JSON 이 아니면 빈 배열
 */
function parsePauseIntervals(
  notes: string | null | undefined,
  end: number,
): Array<[number, number]> {
  if (!notes) return [];
  try {
    const parsed = JSON.parse(notes);
    if (!Array.isArray(parsed?.pauseHistory)) return [];
    const intervals: Array<[number, number]> = [];
    for (const entry of parsed.pauseHistory) {
      const pAt = entry?.pausedAt ? new Date(entry.pausedAt).getTime() : 0;
      const rAt = entry?.resumedAt
        ? new Date(entry.resumedAt).getTime()
        : end;
      if (pAt > 0 && Number.isFinite(rAt) && rAt > pAt) {
        intervals.push([pAt, rAt]);
      }
    }
    return intervals;
  } catch {
    // notes가 JSON이 아니면 무시
    return [];
  }
}

/** 작업 구간에서 중간마감을 제외한다. 열린 중간마감은 전달받은 end까지 적용한다. */
export function activeWorkSegments(
  start: number,
  end: number,
  notes: string | null | undefined,
): Array<[number, number]> {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  // 1) 중간마감 구간: [start, end] 로 클리핑 → 시작순 정렬 → 겹침 병합
  const pauses = parsePauseIntervals(notes, end)
    .map(([p, r]): [number, number] => [Math.max(p, start), Math.min(r, end)])
    .filter(([p, r]) => r > p)
    .sort((a, b) => a[0] - b[0]);

  const merged = mergeIntervals(pauses);

  // 2) 실제 작업 구간 = [start, end] − 중간마감 구간
  const activeSegments: Array<[number, number]> = [];
  let cursor = start;
  for (const [p, r] of merged) {
    if (p > cursor) activeSegments.push([cursor, p]);
    cursor = Math.max(cursor, r);
  }
  if (end > cursor) activeSegments.push([cursor, end]);
  return activeSegments;
}

/** 개인별 동시작업은 합집합으로 계산하고 반올림은 합계 후 한 번만 수행한다. */
export function netMinutesOfSegments(
  segments: Array<[number, number]>,
  breakConfigs?: readonly BreakConfigLike[],
): number {
  let totalMs = 0;
  for (const [s, e] of mergeIntervals(segments)) {
    totalMs += e - s - breakOverlapMs(s, e, breakConfigs);
  }

  return Math.max(0, Math.round(totalMs / 60000));
}

/** 작업 한 건의 순작업시간. 중간마감과 휴게를 제외하고 분 단위 반올림. */
export function calcNetWorkMinutes(
  startedAt: Date,
  endedAt: Date | null,
  notes: string | null,
  breakConfigs?: readonly BreakConfigLike[],
): number {
  return netMinutesOfSegments(
    activeWorkSegments(startedAt.getTime(), endedAt?.getTime() ?? Date.now(), notes),
    breakConfigs,
  );
}

/**
 * 사업장별 휴게시간 설정 조회기
 * - 규칙 (break-configs.service.findForMobile 과 동일): 사업장(siteId) 활성 설정이 1개 이상이면 그것을,
 *   없으면 전역(siteId=null) 활성 설정으로 폴백
 * - siteId 가 NULL(미배정 레거시 작업자)인 경우 → 전역 설정
 */
export interface BreakConfigResolver {
  forSite(siteId: string | null | undefined): BreakConfigLike[];
}

/** 조회에 필요한 최소 Prisma 클라이언트 형태 (PrismaService 호환) */
type BreakConfigPrisma = Pick<PrismaClient, 'breakConfig'>;

/**
 * 필요한 사업장들의 활성 휴게시간 설정을 1회 조회해 resolver 로 반환
 *
 * @param siteIds 조회 대상 사업장 ID 목록 (null/undefined 포함 가능 — 전역 설정은 항상 함께 조회)
 *                빈 배열이면 전역 설정만 조회
 */
export async function loadBreakConfigResolver(
  prisma: BreakConfigPrisma,
  siteIds: Iterable<string | null | undefined>,
): Promise<BreakConfigResolver> {
  const wanted = Array.from(
    new Set(Array.from(siteIds).filter((s): s is string => typeof s === 'string' && s.length > 0)),
  );

  const rows = await prisma.breakConfig.findMany({
    where: {
      isActive: true,
      OR: [{ siteId: null }, ...(wanted.length > 0 ? [{ siteId: { in: wanted } }] : [])],
    },
    select: { siteId: true, startHour: true, startMin: true, endHour: true, endMin: true },
    orderBy: { sortOrder: 'asc' },
  });

  const global: BreakConfigLike[] = [];
  const bySite = new Map<string, BreakConfigLike[]>();
  for (const r of rows) {
    const cfg: BreakConfigLike = {
      startHour: r.startHour,
      startMin: r.startMin,
      endHour: r.endHour,
      endMin: r.endMin,
    };
    if (r.siteId) {
      const list = bySite.get(r.siteId);
      if (list) list.push(cfg);
      else bySite.set(r.siteId, [cfg]);
    } else {
      global.push(cfg);
    }
  }

  return {
    forSite(siteId) {
      if (siteId) {
        const site = bySite.get(siteId);
        // 멀티테넌트 fallback 규칙: 사업장 설정이 하나라도 있으면 그것만, 없으면 전역
        if (site && site.length > 0) return site;
      }
      return global;
    },
  };
}
