import { ForbiddenException } from '@nestjs/common';
import { JwtPayload } from '../decorators/current-user.decorator';

/**
 * siteId 격리 공통 헬퍼
 * - MASTER: querySiteId 사용 가능 (없으면 undefined → 전체 조회)
 * - 그 외: 자기 siteId 강제, 다른 siteId 요청 시 ForbiddenException
 */
export function resolveSiteId(
  user: JwtPayload | undefined,
  querySiteId?: string,
): string | undefined {
  if (!user) return undefined;

  if (user.role === 'MASTER') {
    return querySiteId || undefined;
  }

  // MASTER가 아닌 사용자가 다른 siteId를 요청하면 차단
  if (querySiteId && querySiteId !== user.siteId) {
    throw new ForbiddenException('자신의 사업장만 조회할 수 있습니다');
  }

  return user.siteId;
}
