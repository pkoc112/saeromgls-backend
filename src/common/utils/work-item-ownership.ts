import { ForbiddenException } from '@nestjs/common';

/**
 * P0-4: 모바일 작업 엔드포인트 소유자 검증
 *
 * 호출자(requester)가 해당 작업에 대한 권한이 있는지 확인:
 *  - 주 작업자(startedByWorkerId) 본인
 *  - 배정된 참여자(assignments.workerId)
 *  - 또는 관리자 역할 (MASTER/ADMIN)
 *
 * 모바일 앱에서 타인의 작업을 임의로 end/pause/resume/void 하는 것을 차단.
 */
export interface OwnershipCheckInput {
  requesterId?: string; // 호출자 worker ID (JwtPayload.sub)
  requesterRole?: string; // 호출자 role (MASTER/ADMIN/SUPERVISOR/WORKER)
  workItem: {
    startedByWorkerId: string;
    assignments?: Array<{ workerId: string }>;
  };
  /** dto.endedByWorkerId 또는 dto.pausedByWorkerId처럼 body에 명시된 작업자 ID */
  dtoWorkerId?: string;
}

export function assertWorkItemOwnership(input: OwnershipCheckInput): void {
  const { requesterId, requesterRole, workItem, dtoWorkerId } = input;

  // 관리자는 항상 허용
  const role = (requesterRole || '').toUpperCase();
  if (role === 'MASTER' || role === 'ADMIN') return;

  // 호출자 ID(JWT sub) 또는 dto에 명시된 작업자 ID 중 하나라도 있으면 검사
  const candidateId = requesterId || dtoWorkerId;
  if (!candidateId) {
    throw new ForbiddenException('작업자 정보가 없어 이 작업을 수행할 수 없습니다');
  }

  const isStarter = workItem.startedByWorkerId === candidateId;
  const isAssigned = (workItem.assignments || []).some((a) => a.workerId === candidateId);

  if (!isStarter && !isAssigned) {
    throw new ForbiddenException('이 작업에 대한 권한이 없습니다');
  }
}
