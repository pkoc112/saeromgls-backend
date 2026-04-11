/**
 * KST (UTC+9) 날짜 변환 유틸리티
 *
 * 프론트엔드에서 'YYYY-MM-DD' 형식으로 전달되는 날짜를
 * 항상 한국 표준시(KST) 기준으로 해석합니다.
 *
 * 예: '2026-04-09' →
 *   시작: 2026-04-08T15:00:00.000Z  (KST 4/9 00:00:00)
 *   종료: 2026-04-09T14:59:59.999Z  (KST 4/9 23:59:59)
 */

/** KST 기준 해당 날짜의 시작 (00:00:00 KST) */
export function kstStartOfDay(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00+09:00`);
}

/** KST 기준 해당 날짜의 종료 (23:59:59.999 KST) */
export function kstEndOfDay(dateStr: string): Date {
  return new Date(`${dateStr}T23:59:59.999+09:00`);
}

/** from~to 날짜 문자열을 KST 기준 Date 범위로 변환 */
export function kstDateRange(from: string, to: string) {
  return {
    fromDate: kstStartOfDay(from),
    toDate: kstEndOfDay(to),
  };
}
