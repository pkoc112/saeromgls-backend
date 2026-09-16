import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 감사 기록(AdminActivityLog)의 시스템 행위자 해결
 *
 * - `admin_activity_logs.actor_worker_id` 는 workers(id) FK(RESTRICT) — 문자열 'SYSTEM' 은 FK 위반으로
 *   INSERT 자체가 실패한다. (크론 실패·백업 지연 경고·구독 자동 전이·자동 확정 기록이 try/catch 에 삼켜져
 *   조용히 사라지고, 백업 경고는 '하루 1회' 판정이 안 돼 재호출마다 재발송되던 원인)
 * - 스키마 변경 없이 해결: role='MASTER' 인 worker 중 가장 오래된 계정을 시스템 행위자로 쓰고,
 *   사람 행위와 구분되도록 metadata 에 `system: true` 를 넣는다 (systemMetadata 헬퍼).
 * - 프로세스 내 캐시: 서버리스 인스턴스 수명 동안 1회만 조회. MASTER 가 없으면 null → 호출 측은 기록을 건너뛰고 warn.
 * - 모듈 DI 없이 PrismaService 만 받는 순수 함수 (backup-heartbeat 와 동일 규칙)
 */

const logger = new Logger('SystemActor');

/** 해결된 시스템 행위자 worker id — 조회 성공 시에만 채움 (null 은 캐시하지 않아 MASTER 생성 후 즉시 반영) */
let cachedSystemActorId: string | null = null;

/**
 * 시스템 행위자(가장 오래된 MASTER) worker id. 없거나 조회 실패면 null.
 */
export async function resolveSystemActorId(prisma: PrismaService): Promise<string | null> {
  if (cachedSystemActorId) return cachedSystemActorId;
  try {
    // 활성(ACTIVE) MASTER 를 우선 — 탈퇴한 계정에 시스템 행위가 귀속되지 않도록. 없으면 아무 MASTER 라도 사용.
    const master =
      (await prisma.worker.findFirst({
        where: { role: 'MASTER', status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })) ??
      (await prisma.worker.findFirst({
        where: { role: 'MASTER' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      }));
    if (!master) return null;
    cachedSystemActorId = master.id;
    return master.id;
  } catch (err) {
    logger.warn(`시스템 행위자(MASTER) 조회 실패: ${err}`);
    return null;
  }
}

/** 캐시 초기화 (테스트/MASTER 교체 시) */
export function resetSystemActorCache(): void {
  cachedSystemActorId = null;
}

/**
 * 시스템 행위 metadata 직렬화 — `system: true` 병합.
 * - JSON 문자열이면 파싱 후 병합 (객체가 아니거나 깨진 JSON 이면 `raw` 로 보존)
 * - 객체면 그대로 병합, 없으면 새로 생성
 */
export function systemMetadata(
  metadata?: string | Record<string, unknown> | null,
): string {
  let base: Record<string, unknown> = {};
  if (typeof metadata === 'string') {
    try {
      const parsed: unknown = JSON.parse(metadata);
      base =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { raw: metadata };
    } catch {
      base = { raw: metadata };
    }
  } else if (metadata && typeof metadata === 'object') {
    base = metadata;
  }
  return JSON.stringify({ ...base, system: true });
}
