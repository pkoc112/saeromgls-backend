/**
 * pauseHistory를 기반으로 일시정지 시간을 차감한 순수 작업시간(분) 계산
 * - startedAt ~ endedAt(또는 now) 사이의 총 시간에서
 * - pauseHistory의 각 (pausedAt ~ resumedAt) 구간을 제외
 * - notes 필드에 JSON { pauseHistory: [{pausedAt, resumedAt}] } 형태로 저장됨
 */
export function calcNetWorkMinutes(
  startedAt: Date,
  endedAt: Date | null,
  notes: string | null,
): number {
  const start = startedAt.getTime();
  const end = endedAt ? endedAt.getTime() : Date.now();
  let totalMs = Math.max(0, end - start);

  if (notes) {
    try {
      const parsed = JSON.parse(notes);
      if (Array.isArray(parsed?.pauseHistory)) {
        for (const entry of parsed.pauseHistory) {
          const pAt = entry.pausedAt ? new Date(entry.pausedAt).getTime() : 0;
          const rAt = entry.resumedAt
            ? new Date(entry.resumedAt).getTime()
            : endedAt
              ? end
              : Date.now();
          if (pAt > 0 && rAt > pAt) {
            totalMs -= rAt - pAt;
          }
        }
      }
    } catch {
      // notes가 JSON이 아니면 무시
    }
  }

  return Math.max(0, Math.round(totalMs / 60000));
}
