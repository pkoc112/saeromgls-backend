import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * JWT 토큰에서 추출된 현재 사용자 정보를 주입하는 파라미터 데코레이터
 *
 * 사용법:
 *   @CurrentUser() user: JwtPayload
 *   @CurrentUser('sub') workerId: string
 */
export interface JwtPayload {
  /** 작업자 ID (UUID) */
  sub: string;
  /** 작업자 역할 */
  role: 'MASTER' | 'ADMIN' | 'SUPERVISOR' | 'WORKER';
  /** 사번 */
  employeeCode: string;
  /** 사업장 ID */
  siteId?: string;
  /** 토큰 발급 시각 */
  iat?: number;
  /** 토큰 만료 시각 */
  exp?: number;
}

export const CurrentUser = createParamDecorator(
  (data: keyof JwtPayload | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as JwtPayload;

    if (!user) {
      return null;
    }

    return data ? user[data] : user;
  },
);
