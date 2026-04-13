/**
 * 동시 작업(배치) 시간 비례 분배 유틸
 *
 * 같은 batchId 또는 같은 작업자의 겹치는 시간대 작업들에 대해
 * 벽시계(wall-clock) 시간을 CBM 비율로 분배합니다.
 *
 * 원칙: 원본 startedAt/endedAt은 건드리지 않고, adjustedMinutes만 계산
 */

interface WorkItemForBatch {
  id: string;
  startedByWorkerId: string;
  batchId?: string | null;
  volume: number | any; // Prisma Decimal
  startedAt: Date;
  endedAt: Date | null;
}

interface AdjustedItem {
  id: string;
  rawMinutes: number;
  adjustedMinutes: number;
  batchKey: string | null;
  concurrentCount: number;
}

/**
 * 작업 목록에 대해 동시작업 보정 시간을 계산합니다.
 *
 * 규칙:
 * 1. batchId가 같은 작업끼리 그룹핑
 * 2. batchId가 없으면 개별 작업으로 취급
 * 3. 배치 벽시계 = min(startedAt) ~ max(endedAt)
 * 4. 각 작업의 보정시간 = 벽시계 × (자기 CBM / 배치 총 CBM)
 * 5. 총 CBM이 0이면 균등 분배
 */
export function calculateBatchAdjustedTime(
  items: WorkItemForBatch[],
): Map<string, AdjustedItem> {
  const result = new Map<string, AdjustedItem>();

  // 배치별 그룹핑
  const batches = new Map<string, WorkItemForBatch[]>();
  const noBatch: WorkItemForBatch[] = [];

  for (const item of items) {
    if (!item.endedAt) {
      // 진행 중인 작업은 보정 없음
      result.set(item.id, {
        id: item.id,
        rawMinutes: 0,
        adjustedMinutes: 0,
        batchKey: null,
        concurrentCount: 1,
      });
      continue;
    }

    if (item.batchId) {
      const key = `${item.startedByWorkerId}_${item.batchId}`;
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key)!.push(item);
    } else {
      noBatch.push(item);
    }
  }

  // 배치 처리
  for (const [batchKey, batchItems] of batches) {
    const minStart = Math.min(...batchItems.map((i) => i.startedAt.getTime()));
    const maxEnd = Math.max(...batchItems.map((i) => i.endedAt!.getTime()));
    const wallClockMs = maxEnd - minStart;
    const wallClockMin = wallClockMs / 60000;

    const totalVolume = batchItems.reduce((s, i) => s + Number(i.volume || 0), 0);

    for (const item of batchItems) {
      const vol = Number(item.volume || 0);
      const rawMs = item.endedAt!.getTime() - item.startedAt.getTime();
      const ratio = totalVolume > 0 ? vol / totalVolume : 1 / batchItems.length;

      result.set(item.id, {
        id: item.id,
        rawMinutes: Math.round(rawMs / 60000),
        adjustedMinutes: Math.round(wallClockMin * ratio),
        batchKey,
        concurrentCount: batchItems.length,
      });
    }
  }

  // 비배치 작업 (개별)
  for (const item of noBatch) {
    if (!item.endedAt) continue;
    const rawMs = item.endedAt.getTime() - item.startedAt.getTime();
    result.set(item.id, {
      id: item.id,
      rawMinutes: Math.round(rawMs / 60000),
      adjustedMinutes: Math.round(rawMs / 60000),
      batchKey: null,
      concurrentCount: 1,
    });
  }

  return result;
}
