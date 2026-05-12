/**
 * 인센티브 엔진 순수 유틸 함수 — 테스트 가능하도록 분리
 */

export const MIN_WORKERS = 3;
// 2026-05-12 v3.1 freeze: 3 → 8일로 상향 (Deep Research 권고)
// 소표본 noise 보호 — 월 3일 근무자는 voidRate/editRate가 1~2건만으로 등급이 흔들림
export const MIN_DAYS_WORKED = 8;
export const WORKING_DAYS = 22;

/** 신 4트랙 */
export const VALID_TRACKS = ['OUTBOUND', 'INBOUND_DOCK', 'INSPECTION', 'MANAGER'] as const;
export type ActiveTrack = typeof VALID_TRACKS[number];

/**
 * 트랙별 카테고리 raw 점수의 nominal max.
 *
 * 2026-05-12 v3.1 freeze (Deep Research 권고):
 *   - 각 카테고리 raw 점수를 nominal max로 정규화한 뒤 가중평균해야 트랙간 등급
 *     일치(예: OUTBOUND 90점 ≡ MANAGER 90점)가 성립.
 *   - 정규화 이전 raw max는 트랙마다 달랐다 — 예) OUTBOUND/INBOUND_DOCK 신뢰도
 *     raw max = 50 (출근 50점만, void/edit는 패널티), INSPECTION 팀워크 raw max
 *     = 60 (teamworkCount × 2). 그대로 가중평균하면 같은 100점이 트랙별로 다른 의미.
 *   - 모든 score function은 normalizeCategory(raw, MAX) 적용 후 가중평균.
 */
export const TRACK_NOMINAL_MAX: Record<
  ActiveTrack,
  { perf: number; rel: number; team: number }
> = {
  OUTBOUND:     { perf: 100, rel: 50,  team: 100 },
  INBOUND_DOCK: { perf: 100, rel: 50,  team: 100 },
  INSPECTION:   { perf: 100, rel: 60,  team: 60  },
  MANAGER:      { perf: 100, rel: 100, team: 100 },
};

/**
 * 카테고리 raw 점수를 0~100 정규화.
 * raw가 max를 넘으면 clamp, max가 0/음수면 0.
 */
export function normalizeCategory(raw: number, max: number): number {
  if (max <= 0) return 0;
  const c = Math.max(0, Math.min(max, raw));
  return fix2((c / max) * 100);
}

/** 구 5트랙 → 신 4트랙 매핑 */
export const TRACK_MIGRATION: Record<string, string> = {
  OUTBOUND_RANKED: 'OUTBOUND',
  INBOUND_SUPPORT: 'INBOUND_DOCK',
  INSPECTION_GOAL: 'INSPECTION',
  DOCK_WRAP_GOAL: 'INBOUND_DOCK',
  MANAGER_OPS: 'MANAGER',
};

/** 기본 지급 밴드 */
export const DEFAULT_PAYOUT_BANDS = [
  { grade: 'A', min: 90, max: 100, amount: 500000 },
  { grade: 'B', min: 80, max: 89, amount: 400000 },
  { grade: 'C', min: 70, max: 79, amount: 300000 },
  { grade: 'D', min: 60, max: 69, amount: 150000 },
  { grade: 'E', min: 0, max: 59, amount: 0 },
];

export type PayoutBand = { grade: string; min: number; max: number; amount: number };

/** 안전 나눗셈 — 분모 0이면 fallback */
export function safeDiv(n: number, d: number, fallback = 0): number {
  return d > 0 ? n / d : fallback;
}

/** 값을 [min, max] 범위로 clamp */
export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** 소수점 2자리 반올림 */
export function fix2(v: number): number {
  return Number(v.toFixed(2));
}

/** 구 트랙 → 신 트랙 변환 (이미 신 트랙이면 그대로) */
export function resolveTrack(raw: string): string {
  return TRACK_MIGRATION[raw] || raw;
}

/** 점수 → 등급/지급액 매핑 */
export function getGrade(
  score: number,
  bands: PayoutBand[] = DEFAULT_PAYOUT_BANDS,
): { grade: string; amount: number } {
  for (const band of bands) {
    if (score >= band.min && score <= band.max) {
      return { grade: band.grade, amount: band.amount };
    }
  }
  return { grade: 'E', amount: 0 };
}

/**
 * baseIncentive로 밴드 금액 비례 스케일링.
 * A등급 금액을 baseIncentive에 맞추고 나머지 밴드는 같은 비율로 조정.
 */
export function scaleBands(
  bands: PayoutBand[],
  baseIncentive: number,
): PayoutBand[] {
  const aAmount = bands.find((b) => b.grade === 'A')?.amount || 500000;
  if (aAmount <= 0 || baseIncentive === aAmount) return bands;
  const scale = baseIncentive / aAmount;
  return bands.map((b) => ({ ...b, amount: Math.round(b.amount * scale) }));
}

/**
 * 정책 details에서 설정값 추출 (기본값 폴백).
 * 각 사업장이 working days / min workers / payoutBands를 오버라이드 가능.
 */
export function readPolicyConfig(details: unknown): {
  workingDays: number;
  minWorkers: number;
  minDaysWorked: number;
  payoutBands: PayoutBand[];
} {
  const d = (details && typeof details === 'object') ? (details as Record<string, unknown>) : {};
  return {
    workingDays: typeof d.workingDays === 'number' && d.workingDays > 0 ? d.workingDays : WORKING_DAYS,
    minWorkers: typeof d.minWorkers === 'number' && d.minWorkers > 0 ? d.minWorkers : MIN_WORKERS,
    minDaysWorked: typeof d.minDaysWorked === 'number' && d.minDaysWorked > 0 ? d.minDaysWorked : MIN_DAYS_WORKED,
    payoutBands: Array.isArray(d.payoutBands) ? (d.payoutBands as PayoutBand[]) : DEFAULT_PAYOUT_BANDS,
  };
}
