/**
 * 인센티브 엔진 순수 유틸 함수 — 테스트 가능하도록 분리
 */

export const MIN_WORKERS = 3;
export const MIN_DAYS_WORKED = 3;
export const WORKING_DAYS = 22;

/** 신 4트랙 */
export const VALID_TRACKS = ['OUTBOUND', 'INBOUND_DOCK', 'INSPECTION', 'MANAGER'] as const;
export type ActiveTrack = typeof VALID_TRACKS[number];

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
