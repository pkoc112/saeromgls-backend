import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { JwtPayload } from '../common/decorators/current-user.decorator';

/**
 * 역할 기반 접근 제어 (RBAC) 가드
 * @Roles() 데코레이터에 지정된 역할과 현재 사용자의 역할을 비교
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // @Roles() 데코레이터가 없으면 모든 인증된 사용자 허용
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload;

    if (!user) {
      throw new ForbiddenException('인증 정보가 없습니다');
    }

    // MASTER는 모든 권한을 가진 최상위 역할 — 항상 통과
    const hasRole = user.role === 'MASTER' || requiredRoles.some((role) => user.role === role);
    if (!hasRole) {
      throw new ForbiddenException(
        `이 작업을 수행하려면 다음 역할 중 하나가 필요합니다: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
