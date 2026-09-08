import { BadRequestException } from '@nestjs/common';

// 긴 오프라인 기록은 보관하되, 기기 시계 오설정은 관리자 확인 대상으로 남긴다.
const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export function resolveWorkEventTime(
  occurredAt?: string,
  work?: { startedAt: Date; notes?: string | null },
  now = new Date(),
): Date {
  let minimum = work?.startedAt.getTime() ?? 0;
  if (work?.notes) {
    try {
      const history = JSON.parse(work.notes)?.pauseHistory;
      if (Array.isArray(history)) {
        for (const entry of history) {
          for (const value of [entry.pausedAt, entry.resumedAt]) {
            const time = Date.parse(value);
            if (Number.isFinite(time)) minimum = Math.max(minimum, time);
          }
        }
      }
    } catch { /* Legacy free-text notes have no event times. */ }
  }
  if (occurredAt === undefined) return new Date(Math.max(now.getTime(), minimum));
  const time = Date.parse(occurredAt);
  if (!Number.isFinite(time) || !/(Z|[+-]\d{2}:\d{2})$/.test(occurredAt)) {
    throw new BadRequestException('작업 시각에는 올바른 날짜와 시간대가 필요합니다');
  }
  if (time > now.getTime() + CLOCK_SKEW_MS || time < now.getTime() - MAX_EVENT_AGE_MS) {
    throw new BadRequestException('기기 작업 시각이 허용 범위를 벗어났습니다. 기록을 보관하고 관리자에게 확인해주세요');
  }
  if (time < minimum) {
    throw new BadRequestException('작업 시각이 이전 작업 동작보다 빠릅니다. 기기 시간을 확인해주세요');
  }
  return new Date(time);
}
