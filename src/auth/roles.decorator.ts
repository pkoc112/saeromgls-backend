import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * 엔드포인트에 필요한 역할을 지정하는 데코레이터
 *
 * 사용법:
 *   @Roles('ADMIN', 'SUPERVISOR')
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
